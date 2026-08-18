import type { JsonObject, JsonValue } from "@brainstorm-agentic/core";

import type {
  ClassificationFact,
  FailureFact,
  PanelFact,
  ReviewFact,
  RoleFact,
  RunSummary,
  StageFact,
  TaxonomyFact,
} from "./types.js";

/**
 * The inputs a run leaves behind. Deliberately structural rather than typed
 * against the runtime's own interfaces: the summary is derived from a finished
 * run's recorded facts, and coupling it to live types would make every runtime
 * refactor a telemetry change.
 */
export interface RunFacts {
  readonly status: string;
  readonly events: readonly JsonObject[];
  readonly journal: readonly JsonObject[];
  /** The final brainstorm state, from the last journaled activity result. */
  readonly state?: JsonObject;
}

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function arr(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** The stage a node path belongs to: the first segment under the workflow root. */
function stageOf(path: string): string | undefined {
  const parts = path.split("/");
  return parts.length >= 2 ? parts[1] : undefined;
}

/** Whether a path names a stage itself rather than something nested inside it. */
function isStagePath(path: string): boolean {
  return path.split("/").length === 2;
}

function stageFacts(events: readonly JsonObject[]): StageFact[] {
  const started = new Map<string, number>();
  const facts = new Map<string, { status: StageFact["status"]; durationMs?: number; agentTasks: number }>();
  const ensure = (id: string) =>
    facts.get(id) ?? facts.set(id, { status: "incomplete", agentTasks: 0 }).get(id)!;

  for (const event of events) {
    const type = str(event.type);
    const path = str(event.path);
    const at = num(event.at);
    if (!type || !path) continue;
    const stage = stageOf(path);
    if (!stage) continue;

    if (type === "agent:started") ensure(stage).agentTasks += 1;
    if (!isStagePath(path)) continue;
    if (type === "node:started" && at !== undefined) started.set(path, at);
    if (type === "node:completed" || type === "node:failed") {
      const fact = ensure(stage);
      const begin = started.get(path);
      if (begin !== undefined && at !== undefined) fact.durationMs = at - begin;
      // A stage that restarts (a retry or a credit resume) sheds its earlier
      // failure: the last outcome recorded is the one that stands.
      fact.status = type === "node:completed" ? "completed" : "failed";
    }
  }
  return [...facts].map(([stageId, fact]) => ({ stageId, ...fact }));
}

/**
 * Per-role cost and latency, joined on taskId — stable across retries and
 * resumes.
 *
 * Spend comes from the completion EVENTS, which carry each attempt's usage:
 * a failed attempt spends real tokens and is never journaled, so a
 * journal-only total silently under-reports every retried task and disagrees
 * with the dashboard's figure for the same run. Runs recorded before events
 * carried usage still fall back to the journal.
 */
function roleFacts(
  events: readonly JsonObject[],
  journal: readonly JsonObject[],
): RoleFact[] {
  interface MutableRole {
    role: string;
    tasks: number;
    failures: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  }
  const roles = new Map<string, MutableRole>();
  /** Tasks whose spend the event stream already supplied. */
  const countedFromEvents = new Set<string>();
  const addUsage = (fact: MutableRole, usage: JsonObject): void => {
    fact.inputTokens += num(usage.inputTokens) ?? 0;
    fact.outputTokens += num(usage.outputTokens) ?? 0;
    fact.cacheReadTokens += num(usage.cacheReadInputTokens) ?? 0;
    fact.cacheWriteTokens += num(usage.cacheWriteInputTokens) ?? 0;
    fact.reasoningTokens += num(usage.reasoningTokens) ?? 0;
  };
  const ensure = (role: string): MutableRole => {
    const existing = roles.get(role);
    if (existing) return existing;
    const fresh: MutableRole = {
      role,
      tasks: 0,
      failures: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    roles.set(role, fresh);
    return fresh;
  };

  const startedAt = new Map<string, number>();
  const kindOfTask = new Map<string, string>();
  for (const event of events) {
    const type = str(event.type);
    const taskId = str(event.taskId);
    const kind = str(event.taskKind);
    const at = num(event.at);
    if (!type || !taskId || !kind) continue;
    kindOfTask.set(taskId, kind);
    if (type === "agent:started" && at !== undefined) startedAt.set(taskId, at);
    if (type === "agent:completed") {
      const fact = ensure(kind);
      fact.tasks += 1;
      if (str(event.status) === "error") fact.failures += 1;
      const begin = startedAt.get(taskId);
      if (begin !== undefined && at !== undefined) fact.durationMs += at - begin;
      // Each ATTEMPT's spend rides its completion event, failed attempts
      // included — and a failed attempt buys real tokens. Counting them is
      // what makes this total the money actually spent, and what keeps it
      // equal to the figure the dashboard shows for the same run.
      const usage = obj(event.usage);
      if (usage) {
        addUsage(fact, usage);
        countedFromEvents.add(taskId);
      }
    }
  }

  // Runs recorded before completion events carried usage fall back to the
  // journaled AgentResult — the successful attempt only, which is all those
  // runs ever recorded. Tasks already counted above are skipped, or their
  // successful attempt would be added twice.
  for (const entry of journal) {
    if (str(entry.kind) !== "agent") continue;
    const value = obj(entry.value);
    const taskId = str(value?.taskId);
    const usage = obj(value?.usage);
    if (!taskId || !usage || countedFromEvents.has(taskId)) continue;
    const role = kindOfTask.get(taskId);
    if (!role) continue;
    addUsage(ensure(role), usage);
  }
  return [...roles.values()];
}

/* ------------------------------------------------------------------------
 * Journal-sourced facts (format-2 journals).
 *
 * Pre-fold journals carried the full run state, and the facts below read it
 * directly. Format-2 journals carry only real outputs, so the same facts are
 * derived from the recorded entries instead: a content activity's output
 * lives under its `<id>-run` node, agent outputs under `<id>-execute`, and
 * gate answers under their gate/auto entries.
 * ---------------------------------------------------------------------- */

/** A journaled agent entry's output, when the task succeeded. */
function agentEntryOutput(entry: JsonObject): JsonObject | undefined {
  if (str(entry.kind) !== "agent") return undefined;
  const value = obj(entry.value);
  if (value?.status !== "ok") return undefined;
  return obj(value.output);
}

/** The LAST recorded output of a content activity node (format-2 layout). */
function journalRunOutput(
  journal: readonly JsonObject[],
  nodeId: string,
): JsonObject | undefined {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index]!;
    const key = str(entry.key);
    if (key?.endsWith(`/${nodeId}/${nodeId}-run::result`)) return obj(entry.value);
  }
  return undefined;
}

/** The recorded answer of a human gate (manual response or auto decision). */
function journalGateAnswer(
  journal: readonly JsonObject[],
  gateId: string,
): JsonObject | undefined {
  for (const entry of journal) {
    const key = str(entry.key);
    if (!key?.includes(`/${gateId}`)) continue;
    if (str(entry.kind) === "gate" && key.endsWith("::response")) return obj(entry.value);
    if (key.endsWith(`/${gateId}-auto::result`)) return obj(entry.value);
  }
  return undefined;
}

/** Review coordinates from a journal key (both review topologies). */
function reviewCoordinates(key: string): {
  member?: number;
  step?: number;
  round?: number;
} {
  const number = (pattern: RegExp): number | undefined => {
    const match = pattern.exec(key);
    return match ? Number(match[1]) : undefined;
  };
  return {
    member: number(/review-members(?:\/review-members-fanout)?\/member\[(\d+)\]/),
    step: number(/cotStep\[(\d+)\]/),
    round: number(/iter\[(\d+)\]/),
  };
}

function classificationFact(state: JsonObject | undefined): ClassificationFact | undefined {
  const input = obj(state?.input);
  if (!input) return undefined;
  const gates = obj(obj(state?._runtime)?.gates);
  const decision = gates ? obj(Object.values(gates).find((value) => obj(value)?.action)) : undefined;
  const action = str(decision?.action);
  return {
    ...(str(input.type) !== undefined ? { type: str(input.type)! } : {}),
    ...(num(input.cotSteps) !== undefined ? { cotSteps: num(input.cotSteps)! } : {}),
    requestedOutputs: arr(input.requestedOutputs).length,
    ...(action === "approve" || action === "revise" ? { gateAction: action } : {}),
  };
}

function classificationFactFromJournal(
  journal: readonly JsonObject[],
): ClassificationFact | undefined {
  const input = journalRunOutput(journal, "apply-classification");
  if (!input) return undefined;
  const answer = journalGateAnswer(journal, "confirm-classification");
  const action = str(answer?.action);
  // A revised gate answer overrides the classifier's primary reading.
  const type = str(answer?.type) ?? str(input.type);
  const requested =
    answer?.requestedOutputs !== undefined
      ? arr(answer.requestedOutputs)
      : arr(input.requestedOutputs);
  return {
    ...(type !== undefined ? { type } : {}),
    ...(num(input.cotSteps) !== undefined ? { cotSteps: num(input.cotSteps)! } : {}),
    requestedOutputs: requested.length,
    ...(action === "approve" || action === "revise" ? { gateAction: action } : {}),
  };
}

function panelMembersFact(members: readonly JsonValue[]): PanelFact | undefined {
  if (members.length === 0) return undefined;
  const fields = new Set<string>();
  let interdisciplinary = false;
  let custom = 0;
  for (const raw of members) {
    const member = obj(raw);
    if (!member) continue;
    const umbrella = str(member.umbrella);
    if (umbrella) fields.add(umbrella);
    if (str(member.seat) === "interdisciplinary") interdisciplinary = true;
    if (str(member.id)?.startsWith("member-user-")) custom += 1;
  }
  return {
    seats: members.length,
    distinctFields: fields.size,
    hasInterdisciplinarySeat: interdisciplinary,
    removedSeats: 0,
    customSeats: custom,
  };
}

function panelFact(state: JsonObject | undefined): PanelFact | undefined {
  return panelMembersFact(arr(obj(state?.panel)?.members));
}

function panelFactFromJournal(journal: readonly JsonObject[]): PanelFact | undefined {
  const panel =
    journalRunOutput(journal, "weave-panel") ?? journalRunOutput(journal, "select-panel");
  let members = arr(panel?.members);
  if (members.length === 0) return undefined;
  // The recorded panel is the woven proposal; the confirmation gate's answer
  // (shrink and/or custom seats) decides what actually ran.
  const answer = journalGateAnswer(journal, "confirm-panel");
  const kept = arr(answer?.members).filter((id): id is string => typeof id === "string");
  if (str(answer?.action) === "shrink" && kept.length > 0) {
    const retain = new Set(kept);
    members = members.filter((member) => {
      const id = str(obj(member)?.id);
      return id !== undefined && retain.has(id);
    });
  }
  const added = arr(answer?.addedMembers).flatMap((raw) => {
    const seat = obj(raw);
    // Runtime-minted ids are not in the answer; stamp the custom prefix so
    // the fact counts them exactly as the state-based reader did.
    return seat ? [{ ...seat, id: "member-user-added" } as JsonValue] : [];
  });
  return panelMembersFact([...members, ...added]);
}

/**
 * Review outcomes, read from the per-member ledger the runtime writes. The
 * ledger is content-only by construction (no commentor identity), and only its
 * counts are taken here — never any objection text.
 */
function reviewFact(state: JsonObject | undefined): ReviewFact | undefined {
  const log = obj(state?.reviewLog);
  if (!log) return undefined;
  const verdicts: Record<string, number> = {};
  const roundsHistogram: Record<string, number> = {};
  let mustAddress = 0;
  let verified = 0;
  let authority = 0;
  let redevelopments = 0;
  let passed = 0;
  let forcePassed = 0;
  let anyEntries = false;

  for (const memberEntries of Object.values(log)) {
    // Rounds are appended chronologically; the last entry at a walk position
    // is that step's outcome.
    const byStep = new Map<number, JsonObject[]>();
    for (const raw of arr(memberEntries)) {
      const entry = obj(raw);
      const step = num(entry?.step);
      if (!entry || step === undefined) continue;
      anyEntries = true;
      byStep.set(step, [...(byStep.get(step) ?? []), entry]);
      const verdict = str(entry.verdict);
      if (verdict) verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
      if (Array.isArray(entry.touched)) redevelopments += 1;
      for (const rawIssue of arr(entry.issues)) {
        const issue = obj(rawIssue);
        if (!issue) continue;
        if (issue.mustAddress === true) mustAddress += 1;
        if (str(issue.basis) === "verified") verified += 1;
        else authority += 1;
      }
    }
    for (const rounds of byStep.values()) {
      const last = rounds[rounds.length - 1];
      const outcome = str(last?.verdict);
      if (outcome === "Pass") passed += 1;
      else forcePassed += 1;
      const key = String(rounds.length);
      roundsHistogram[key] = (roundsHistogram[key] ?? 0) + 1;
    }
  }
  if (!anyEntries) return undefined;
  return {
    stepsPassed: passed,
    stepsForcePassed: forcePassed,
    roundsHistogram,
    verdicts,
    mustAddressIssues: mustAddress,
    verifiedIssues: verified,
    authorityIssues: authority,
    redevelopments,
  };
}

/**
 * The same review outcomes rebuilt from the journal's agent entries: one
 * judge decision per (seat, step, round) and one redevelopment entry per
 * applied revision. Counts only, exactly like the ledger-based reader.
 */
function reviewFactFromJournal(journal: readonly JsonObject[]): ReviewFact | undefined {
  const verdicts: Record<string, number> = {};
  const roundsHistogram: Record<string, number> = {};
  let mustAddress = 0;
  let verified = 0;
  let authority = 0;
  let redevelopments = 0;
  const lastVerdictByStep = new Map<string, { round: number; verdict?: string }>();
  let anyEntries = false;

  for (const entry of journal) {
    const key = str(entry.key);
    if (!key?.includes("/review-members")) continue;
    const output = agentEntryOutput(entry);
    if (!output) continue;
    const at = reviewCoordinates(key);
    if (at.member === undefined || at.step === undefined || at.round === undefined) continue;
    if (/\/redevelop-idea(?:\/redevelop-idea-execute)?::result$/.test(key)) {
      redevelopments += 1;
      continue;
    }
    if (!/\/judge-step(?:\/judge-step-execute)?::result$/.test(key)) continue;
    anyEntries = true;
    const verdict = str(output.verdict);
    if (verdict) verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
    for (const rawIssue of arr(output.issues)) {
      const issue = obj(rawIssue);
      if (!issue) continue;
      if (issue.mustAddress === true) mustAddress += 1;
      if (str(issue.basis) === "verified") verified += 1;
      else authority += 1;
    }
    const stepKey = `${at.member}:${at.step}`;
    const incumbent = lastVerdictByStep.get(stepKey);
    if (!incumbent || at.round >= incumbent.round) {
      lastVerdictByStep.set(stepKey, {
        round: at.round,
        ...(verdict !== undefined ? { verdict } : {}),
      });
    }
  }
  if (!anyEntries) return undefined;
  let passed = 0;
  let forcePassed = 0;
  for (const { round, verdict } of lastVerdictByStep.values()) {
    if (verdict === "Pass") passed += 1;
    else forcePassed += 1;
    const rounds = String(round + 1);
    roundsHistogram[rounds] = (roundsHistogram[rounds] ?? 0) + 1;
  }
  return {
    stepsPassed: passed,
    stepsForcePassed: forcePassed,
    roundsHistogram,
    verdicts,
    mustAddressIssues: mustAddress,
    verifiedIssues: verified,
    authorityIssues: authority,
    redevelopments,
  };
}

function taxonomyMatchesFact(
  matches: JsonObject | undefined,
  receiptQueued: number | undefined,
): TaxonomyFact | undefined {
  if (!matches) return undefined;
  const ids: string[] = [];
  const matchedOn: Record<string, number> = {};
  for (const raw of arr(matches.members)) {
    const member = obj(raw);
    const position = obj(member?.match) ?? obj(member?.position);
    const id = str(position?.id) ?? str(position?.nodeId);
    if (id) ids.push(id);
    const lane = str(position?.matchedOn);
    if (lane) matchedOn[lane] = (matchedOn[lane] ?? 0) + 1;
  }
  return {
    ...(num(matches.revision) !== undefined ? { revision: num(matches.revision)! } : {}),
    resolvedNodeIds: [...new Set(ids)].sort(),
    matchedOn,
    unmatched: arr(matches.unmatched).length,
    suggested: receiptQueued ?? 0,
  };
}

function taxonomyFact(state: JsonObject | undefined): TaxonomyFact | undefined {
  return taxonomyMatchesFact(
    obj(state?.poolMatches),
    num(obj(state?.suggestionReceipt)?.queued),
  );
}

function taxonomyFactFromJournal(journal: readonly JsonObject[]): TaxonomyFact | undefined {
  return taxonomyMatchesFact(
    journalRunOutput(journal, "match-taxonomy"),
    num(journalRunOutput(journal, "submit-decisions")?.queued),
  );
}

/** Failures as error CLASSES: a message could echo submission text. */
function failureFacts(events: readonly JsonObject[]): FailureFact[] {
  const failures: FailureFact[] = [];
  for (const event of events) {
    const type = str(event.type);
    if (type !== "node:failed" && type !== "run:failed") continue;
    const error = obj(event.error);
    const path = str(event.path);
    failures.push({
      ...(path ? { nodePath: path, ...(stageOf(path) ? { stageId: stageOf(path)! } : {}) } : {}),
      errorName: str(error?.name) ?? "Error",
    });
  }
  return failures;
}

/** Builds the one compact record that answers most questions about a run. */
export function deriveRunSummary(facts: RunFacts): RunSummary {
  const { events, journal, state } = facts;
  const times = events.map((event) => num(event.at)).filter((at): at is number => at !== undefined);
  const started = events.find((event) => str(event.type) === "run:started");
  // State-sourced facts come from pre-fold journals (which carried the run
  // state); format-2 journals carry only outputs, so the same facts are
  // derived from the recorded entries instead.
  const review = reviewFact(state) ?? reviewFactFromJournal(journal);
  const taxonomy = taxonomyFact(state) ?? taxonomyFactFromJournal(journal);
  const classification = classificationFact(state) ?? classificationFactFromJournal(journal);
  const panel = panelFact(state) ?? panelFactFromJournal(journal);
  return {
    status: facts.status,
    ...(times.length >= 2
      ? { durationMs: Math.max(...times) - Math.min(...times) }
      : {}),
    resumed: started?.resumed === true,
    stages: stageFacts(events),
    roles: roleFacts(events, journal),
    ...(classification ? { classification } : {}),
    ...(panel ? { panel } : {}),
    ...(review ? { review } : {}),
    ...(taxonomy ? { taxonomy } : {}),
    failures: failureFacts(events),
  };
}
