/**
 * The `fact_table` host tool: the public conversation with the supreme judge,
 * satisfying the `fact-table` capability. New bundles mediate every operation;
 * the direct, lexical implementation below serves legacy pinned bundles only.
 *
 * A seat verifies independently asserted substantive claims here; directly
 * inspectable inferences from stated supported premises need no separate badge.
 * `lookup` asks for conceptual matches; when no entry covers it, `submit` hands the claim, its
 * conditions and the seat's own justification to the supreme judge, which
 * re-checks it with its own tools and rules on it (minutes, not seconds);
 * `status` reports the current standing of badges — by id, or every badge
 * the chain the task was shown cites. Seats cite the badges they rely on
 * inline as `[F:n]`.
 *
 * Every answer is anonymous: it never says who submitted, relied on, or
 * challenged an entry, so a lookup shares verified facts and nothing of
 * another seat's reasoning. The table itself (persistence, the verifier, the
 * commit rules) is the worker's FactAccess; this module parses requests and
 * enforces the public gateway. The legacy branch still ranks and formats directly.
 */
import type {
  FactAccess,
  FactCase,
  FactEntry,
  FactKind,
  FactScope,
  FactSubmissionOutcome,
  FactSubmitContext,
  FactTaskBinding,
  HostToolManifest,
  JsonObject,
  JsonValue,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@brainstorm-agentic/core";
import { DEFAULT_FACT_TABLE_LIMITS, FACT_KINDS, factDeletionAlert, factRequesterOf, isFactId } from "@brainstorm-agentic/core";

import { rankFacts } from "./facts/rank.js";

const lines = (...text: readonly string[]): string => text.join("\n");

export const FACT_TABLE_MODES = ["lookup", "status", "submit", "approve"] as const;
export type FactTableMode = (typeof FACT_TABLE_MODES)[number];

/** Field ceilings: a claim is one sentence, evidence is what a checker needs, never a whole file. */
const MAX_CLAIM_CHARS = 600;
const MAX_CONDITIONS_CHARS = 1_200;
const MAX_EVIDENCE_CHARS = 12_000;
const MAX_PURPOSE_CHARS = 600;
const MAX_IDS = 40;
const MAX_RESULTS = 10;

export const FACT_TABLE_DEFINITION = {
  name: "fact_table",
  description: lines(
    "Chat with the supreme judge, the sole agent with direct access to the fact table. Verify independently asserted substantive factual, scientific, or mathematical claims here, and cite a justified badge inline as [F:n] alongside the claim, within its stated conditions. Your own proofs, derivations, calculations, and code checks can justify a claim, as can verified sources. Supply message when you need to explain your question. Legacy pinned bundles retain their earlier lookup/status behavior.",
    "Ordinary connective prose, stipulated definitions, explicit conditional reasoning, and directly inspectable inferences from stated supported premises need no separate badge. A report may have no badge when it relies only on such reasoning. Neither a badge elsewhere nor a label such as 'common knowledge', 'derivation', or 'assumption' licenses an unsupported substantive claim or hidden premise.",
    "Modes:",
    "- \"lookup\" (default): ask the supreme judge to search conceptually for claims equivalent to, supporting, or conflicting with yours, regardless of wording. It checks meaning and conditions, including negation and scope. The response includes relevant badge ids and hashes. max_results limits the answer, not the search coverage. Consult before submitting new evidence; consultations may take minutes.",
    "- \"submit\": when no entry covers your claim, justify it yourself. Give the claim (one self-contained sentence about the code, the record, a result, the literature or mathematics — never about the chain, a step, or a board member), its conditions (quantity, value, dataset, scale, seed, code version, file and line, source — or \"none\"), your evidence (the script and its printed output, the quoted passage with its URL or DOI, the file path and line with the quoted code, or the derivation), its kind, and the step it supports. The supreme judge re-checks it with its own tools and rules on it; this takes minutes. Submit only facts your reasoning actually stands on.",
    "- \"status\": the current standing of badges by id (ids: [\"F:3\", \"F:12\"]); without ids, every badge the chain you were shown cites, step by step, with an alert for each one that is no longer justified.",
    "- \"approve\" (committee chair only, mediated bundles): ask whether factId with its exact badgeHash supports criticId's actual report. Give the intended claim and conditions when helpful. The supreme judge checks the issued justification, current standing and applicability, and returns a host-recorded approvalId. Copy its receipt into your fact check. A hash identifies a record; it does not by itself prove applicability or current approval.",
    "A submission's answer is one case: justified (an entry already covers it — cite that id), justified-new (verified now — a new badge), narrowed (true only under narrower conditions — restate your claim within them), conflict (it contradicts an entry that stands — reconsider every step you meant to build on it), refuted (false — drop it and what rests on it), unverified (it could not be checked — keep any reasoning conditional on it, never treat it as established), or not-a-fact (a nonfactual opinion or design recommendation, or a statement with no independent substantive assertion — argue it in your reasoning instead).",
    "An entry your claim contradicts is re-examined too: a ruling can revoke it, narrow it, or leave both disputed. Only an entry with status \"justified\" is a badge; nobody may rely on a disputed, revoked or refuted one.",
    "Answers never say who submitted or relied on an entry. Evidence you submit must be real: fabricated or misrepresented evidence is recorded against its submitter.",
  ),
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: [...FACT_TABLE_MODES],
        default: "lookup",
        description: "lookup (conceptual consultation), submit (justify a claim), status (badge standing), or approve (committee chair's use check).",
      },
      message: { type: "string", maxLength: MAX_EVIDENCE_CHARS, description: "Optional question or context for the supreme judge." },
      factId: { type: "string", pattern: "^F:[1-9][0-9]*$", description: "approve: the badge cited in this critic's report." },
      badgeHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$", description: "approve: exact host-issued badge hash returned by the supreme judge." },
      criticId: { type: "string", maxLength: MAX_PURPOSE_CHARS, description: "approve: the critic whose report uses this badge." },
      claim: {
        type: "string",
        maxLength: MAX_CLAIM_CHARS,
        description:
          "lookup and submit: the fact as one self-contained sentence about the code, the record, a result, the literature or mathematics.",
      },
      conditions: {
        type: "string",
        maxLength: MAX_CONDITIONS_CHARS,
        description:
          "submit (and optionally lookup): the conditions the fact is claimed under — quantity, value, dataset, scale, seed, code version, file and line, source — or \"none\".",
      },
      evidence: {
        type: "string",
        maxLength: MAX_EVIDENCE_CHARS,
        description:
          "submit: your justification — the script and its printed output, the quoted passage with its URL or DOI, the file path and line with the quoted code, or the derivation.",
      },
      kind: {
        type: "string",
        enum: [...FACT_KINDS],
        description:
          "submit: what the fact is about — code (the attached code), record (the run's own record or the submission's files), result (an empirical result), literature, math, or background (established domain knowledge).",
      },
      step: {
        type: "integer",
        minimum: 1,
        description: "submit: the chain step the fact supports, or the step you are reviewing.",
      },
      purpose: {
        type: "string",
        maxLength: MAX_PURPOSE_CHARS,
        description: "submit (optional): what your reasoning builds on the fact.",
      },
      ids: {
        type: "array",
        items: { type: "string", pattern: "^F:[1-9][0-9]*$" },
        maxItems: MAX_IDS,
        description: "status: badge ids such as \"F:12\". Omit for every badge the chain you were shown cites.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULTS,
        description: "lookup: how many entries to return (default 5).",
      },
    },
    additionalProperties: false,
  },
} as const;

export const FACT_TABLE_MANIFEST: HostToolManifest = {
  toolId: "fact_table",
  displayName: "Fact Table",
  operations: ["fact.lookup", "fact.status", "fact.submit", "fact.approve"],
  risk: "low",
  defaultEnabled: true,
  definition: FACT_TABLE_DEFINITION,
};

export const FACT_MANIFESTS: readonly HostToolManifest[] = [FACT_TABLE_MANIFEST];
export const FACT_TOOL_NAMES = ["fact_table"] as const;

export class FactQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactQueryError";
  }
}

/** One parsed fact_table call. */
export interface FactTableQuery {
  readonly mode: FactTableMode;
  readonly message?: string;
  readonly factId?: string;
  readonly badgeHash?: string;
  readonly criticId?: string;
  readonly claim?: string;
  readonly conditions?: string;
  readonly evidence?: string;
  readonly kind?: FactKind;
  readonly step?: number;
  readonly purpose?: string;
  readonly ids?: readonly string[];
  readonly maxResults?: number;
}

const INPUT_KEYS = new Set(["mode", "claim", "conditions", "evidence", "kind", "step", "purpose", "ids", "max_results", "message", "factId", "badgeHash", "criticId"]);

function optionalText(record: Record<string, unknown>, key: string, ceiling: number): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new FactQueryError(`\`${key}\` must be a string.`);
  const text = value.trim();
  if (text.length > ceiling) {
    throw new FactQueryError(`\`${key}\` is ${text.length} characters; keep it under ${ceiling}.`);
  }
  return text === "" ? undefined : text;
}

/** Validates one call's arguments; a FactQueryError carries the message the agent sees. */
export function parseFactInput(input: JsonValue): FactTableQuery {
  const record: Record<string, unknown> =
    typeof input === "object" && input !== null && !Array.isArray(input) ? { ...(input as JsonObject) } : {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FactQueryError("The fact table takes one JSON object of arguments.");
  }
  const unknown = Object.keys(record).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new FactQueryError(
      `Unknown argument(s): ${unknown.join(", ")}. Allowed: ${[...INPUT_KEYS].join(", ")}.`,
    );
  }
  const rawMode = record.mode ?? "lookup";
  if (typeof rawMode !== "string" || !(FACT_TABLE_MODES as readonly string[]).includes(rawMode)) {
    throw new FactQueryError(`\`mode\` must be one of ${FACT_TABLE_MODES.join(", ")}.`);
  }
  const mode = rawMode as FactTableMode;
  const claim = optionalText(record, "claim", MAX_CLAIM_CHARS);
  const conditions = optionalText(record, "conditions", MAX_CONDITIONS_CHARS);
  const evidence = optionalText(record, "evidence", MAX_EVIDENCE_CHARS);
  const purpose = optionalText(record, "purpose", MAX_PURPOSE_CHARS);
  const message = optionalText(record, "message", MAX_EVIDENCE_CHARS);
  const factId = optionalText(record, "factId", MAX_PURPOSE_CHARS);
  const badgeHash = optionalText(record, "badgeHash", 71);
  const criticId = optionalText(record, "criticId", MAX_PURPOSE_CHARS);
  if (factId !== undefined && !isFactId(factId)) throw new FactQueryError("`factId` must be a badge id such as F:12.");
  if (badgeHash !== undefined && !/^sha256:[a-f0-9]{64}$/.test(badgeHash)) {
    throw new FactQueryError("`badgeHash` must be the exact sha256 hash returned by the supreme judge.");
  }
  if (mode === "approve" && (factId === undefined || badgeHash === undefined || criticId === undefined)) {
    throw new FactQueryError("`approve` needs `factId`, `badgeHash`, and `criticId`.");
  }
  let kind: FactKind | undefined;
  if (record.kind !== undefined && record.kind !== null) {
    if (typeof record.kind !== "string" || !(FACT_KINDS as readonly string[]).includes(record.kind)) {
      throw new FactQueryError(`\`kind\` must be one of ${FACT_KINDS.join(", ")}.`);
    }
    kind = record.kind as FactKind;
  }
  let step: number | undefined;
  if (record.step !== undefined && record.step !== null) {
    if (typeof record.step !== "number" || !Number.isSafeInteger(record.step) || record.step < 1) {
      throw new FactQueryError("`step` must be a chain step number (1 or more).");
    }
    step = record.step;
  }
  let ids: string[] | undefined;
  if (record.ids !== undefined && record.ids !== null) {
    if (!Array.isArray(record.ids)) throw new FactQueryError("`ids` must be a list of badge ids such as \"F:12\".");
    const invalid = record.ids.filter((id) => !isFactId(id));
    if (invalid.length > 0) {
      throw new FactQueryError(`Not badge ids: ${invalid.map((id) => JSON.stringify(id)).join(", ")} (expected \"F:<number>\").`);
    }
    ids = [...new Set(record.ids as string[])];
    if (ids.length > MAX_IDS) throw new FactQueryError(`At most ${MAX_IDS} ids per call.`);
  }
  let maxResults: number | undefined;
  if (record.max_results !== undefined && record.max_results !== null) {
    const value = record.max_results;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_RESULTS) {
      throw new FactQueryError(`\`max_results\` must be between 1 and ${MAX_RESULTS}.`);
    }
    maxResults = value;
  }
  if ((mode === "lookup" || mode === "submit") && claim === undefined) {
    throw new FactQueryError(`\`${mode}\` needs \`claim\`: the fact as one self-contained sentence.`);
  }
  if (mode === "submit") {
    const missing = [
      ...(conditions === undefined ? ["conditions (or \"none\")"] : []),
      ...(evidence === undefined ? ["evidence"] : []),
      ...(kind === undefined ? ["kind"] : []),
    ];
    if (missing.length > 0) {
      throw new FactQueryError(`\`submit\` needs ${missing.join(", ")}.`);
    }
  }
  return {
    mode,
    ...(message !== undefined ? { message } : {}),
    ...(factId !== undefined ? { factId } : {}),
    ...(badgeHash !== undefined ? { badgeHash } : {}),
    ...(criticId !== undefined ? { criticId } : {}),
    ...(claim !== undefined ? { claim } : {}),
    ...(conditions !== undefined ? { conditions } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    ...(ids !== undefined ? { ids } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
  };
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** An entry as an agent may see it: no requester, ever. */
export function factEntryView(entry: FactEntry, evidenceChars = 1_200, withHistory = false): JsonObject {
  return {
    id: entry.id,
    ...(entry.badgeHash !== undefined ? { badgeHash: entry.badgeHash } : {}),
    status: entry.status,
    kind: entry.kind,
    claim: entry.claim,
    conditions: entry.conditions,
    method: entry.method,
    evidence: clip(entry.evidence, evidenceChars),
    ...(entry.supersededBy !== undefined ? { supersededBy: entry.supersededBy } : {}),
    ...(withHistory
      ? {
          history: entry.history.map((event) => ({
            at: new Date(event.at).toISOString(),
            event: event.event,
            ...(event.by !== undefined ? { by: event.by } : {}),
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
          })),
        }
      : {}),
  };
}

/** Why an entry the chain cites can no longer carry the sentence that cites it, if it cannot. */
function alertFor(entry: FactEntry): string | undefined {
  switch (entry.status) {
    case "revoked":
      return entry.supersededBy !== undefined
        ? `${entry.id} was revoked and superseded by ${entry.supersededBy}: whatever cites it stands on a fact the table no longer holds.`
        : `${entry.id} was revoked: whatever cites it stands on a fact the table no longer holds.`;
    case "disputed":
      return `${entry.id} is disputed: nobody may rely on it until a later ruling settles it.`;
    case "refuted":
      return `${entry.id} records a refuted claim: whatever cites it as support stands on a falsehood.`;
    case "justified":
      return entry.history.some((event) => event.event === "narrowed")
        ? `${entry.id} was narrowed after it was issued: check that the citing sentence stays within its current conditions.`
        : undefined;
  }
}

/** What the requester does next, per case. */
function nextStep(outcome: FactSubmissionOutcome): string {
  const id = outcome.badge?.id;
  switch (outcome.case as FactCase) {
    case "justified":
    case "justified-new":
      return `Cite [${id ?? "F:?"}] alongside the claim that relies on this fact, and stay within its conditions.`;
    case "narrowed":
      return `The fact holds only under the badge's conditions: restate your claim within them, cite [${id ?? "F:?"}], and revisit every step that needed the broader claim.`;
    case "conflict":
      return "Your claim contradicts the table. Reconsider every step you meant to build on it: rebuild those steps on the entry that stands, or drop them. A disputed entry may not be relied on by anyone until a later ruling settles it.";
    case "refuted":
      return `The claim is false under the evidence above: drop it and every step built on it.${
        outcome.recorded !== undefined ? ` The table records it as refuted (${outcome.recorded.id}).` : ""
      }`;
    case "unverified":
      return "Do not present this as established: keep any reasoning conditional on it, or submit it again with evidence that can be checked. Labelling it an assumption does not justify an unconditional conclusion.";
    case "not-a-fact":
      return "The table found no independent substantive factual assertion to badge here: argue this point in your reasoning, where the board reviews it. Any substantive factual, scientific, or mathematical premise still needs verification and applicable support.";
  }
}

/** The answer to a submission, as the agent reads it. */
export function formatFactOutcome(outcome: FactSubmissionOutcome): JsonObject {
  const verdict = outcome.verdict;
  return {
    mode: "submit",
    submission: outcome.submission,
    case: outcome.case,
    ...(outcome.badge !== undefined ? { badge: factEntryView(outcome.badge) } : {}),
    ...(verdict !== undefined
      ? {
          ruling: {
            claim: verdict.claim,
            conditions: verdict.conditions,
            method: verdict.method,
            evidence: clip(verdict.evidence, 4_000),
            explanation: verdict.explanation,
          },
        }
      : {}),
    ...(outcome.conflicts.length > 0
      ? {
          conflicts: outcome.conflicts.map((conflict) => ({
            resolution: conflict.resolution,
            explanation: conflict.explanation,
            entry: factEntryView(conflict.entry),
            ...(conflict.deleted === true ? { deleted: true } : {}),
          })),
        }
      : {}),
    ...(outcome.recorded !== undefined ? { recorded: factEntryView(outcome.recorded, 600) } : {}),
    ...(outcome.refusal !== undefined ? { refusal: outcome.refusal } : {}),
    next: nextStep(outcome),
  };
}

function refusal(message: string): ToolResult {
  return { output: message, isError: true };
}

async function lookup(access: FactAccess, query: FactTableQuery, signal?: AbortSignal): Promise<JsonObject> {
  const entries = await access.entries(signal);
  const limit = query.maxResults ?? DEFAULT_FACT_TABLE_LIMITS.lookupResults;
  const ranked = rankFacts(
    entries,
    { claim: query.claim!, ...(query.conditions !== undefined ? { conditions: query.conditions } : {}) },
    limit,
  );
  return {
    mode: "lookup",
    claim: query.claim!,
    results: ranked.map((hit) => ({
      ...factEntryView(hit.entry, 600),
      match: hit.sameClaim ? "same claim" : "related",
    })),
    note:
      ranked.length === 0
        ? "No entry is close to this claim. If your reasoning stands on it, submit it with your justification."
        : "An entry covers your claim only when it states the same fact and its conditions include yours; only status \"justified\" is a badge. Cite it as [F:n]. When none covers your claim, submit it.",
  };
}

async function status(
  access: FactAccess,
  scope: FactScope,
  query: FactTableQuery,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const citedAt = new Map<string, number[]>();
  for (const citation of scope.cited ?? []) {
    for (const id of citation.ids) citedAt.set(id, [...(citedAt.get(id) ?? []), citation.step]);
  }
  const ids = query.ids ?? [...citedAt.keys()];
  if (ids.length === 0) {
    return {
      mode: "status",
      entries: [],
      note:
        query.ids === undefined
          ? "The chain you were shown cites no badge."
          : "No ids were given.",
    };
  }
  const byId = new Map((await access.entries(signal)).map((entry) => [entry.id, entry]));
  // A table that deletes refuted and revoked entries answers a deleted id as
  // deleted, with its replacement when the ruling issued one, never as unknown.
  const deletions = new Map((access.deletions !== undefined ? await access.deletions(signal) : [])
    .map((deletion) => [deletion.id, deletion]));
  const found: JsonObject[] = [];
  const unknown: string[] = [];
  const deleted: JsonObject[] = [];
  const alerts: string[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry === undefined) {
      const deletion = deletions.get(id);
      if (deletion === undefined) {
        unknown.push(id);
        continue;
      }
      const steps = citedAt.get(id);
      deleted.push({ id, ...(deletion.replacedBy !== undefined ? { replacedBy: deletion.replacedBy } : {}) });
      const alert = factDeletionAlert(deletion);
      alerts.push(steps !== undefined ? `${alert} (cited at step ${steps.join(", ")})` : alert);
      continue;
    }
    const steps = citedAt.get(id);
    found.push({ ...factEntryView(entry, 1_200, true), ...(steps !== undefined ? { citedAtSteps: steps } : {}) });
    const alert = alertFor(entry);
    if (alert !== undefined) {
      alerts.push(steps !== undefined ? `${alert} (cited at step ${steps.join(", ")})` : alert);
    }
  }
  return {
    mode: "status",
    entries: found,
    ...(unknown.length > 0 ? { unknown } : {}),
    ...(deleted.length > 0 ? { deleted } : {}),
    alerts,
  };
}

/** Runs one fact_table call for a task acting in `scope`. */
export async function runFactTable(
  access: FactAccess,
  scope: FactScope,
  taskId: string,
  input: JsonValue,
  context: FactSubmitContext = {},
): Promise<ToolResult> {
  let query: FactTableQuery;
  try {
    query = parseFactInput(input);
  } catch (error) {
    if (error instanceof FactQueryError) return refusal(error.message);
    throw error;
  }
  const mediated = access.accessMode === "supreme-mediated/v1";
  if (scope.blindReview !== undefined) {
    if (access.forTask === undefined) {
      throw new Error("Blind review requires an isolated fact-table view; live peer facts cannot be exposed.");
    }
    access = await access.forTask(taskId, scope);
  }
  if (mediated || access.accessMode === "supreme-mediated/v1") {
    if (access.accessMode !== "supreme-mediated/v1" || access.consult === undefined) {
      throw new Error("Supreme-mediated access requires a scoped supreme judge consultation; direct table access is forbidden.");
    }
    if (query.mode === "approve" && scope.role !== "committee-chair") {
      return refusal("Only the committee chair may request approval for a critic's report.");
    }
    const { maxResults, ...consultation } = query;
    return { output: await access.consult(factRequesterOf(scope, taskId), {
      ...consultation,
      ...(maxResults !== undefined ? { max_results: maxResults } : {}),
      ...(query.mode === "status" && query.ids === undefined
        ? { ids: [...new Set((scope.cited ?? []).flatMap((citation) => citation.ids))] } : {}),
    }, context) };
  }
  switch (query.mode) {
    case "approve":
      return refusal("Badge-use approvals require a bundle with supreme-mediated fact access.");
    case "lookup":
      return { output: await lookup(access, query, context.signal) };
    case "status":
      return { output: await status(access, scope, query, context.signal) };
    case "submit": {
      const outcome = await access.submit(
        factRequesterOf(scope, taskId),
        {
          claim: query.claim!,
          conditions: query.conditions!,
          evidence: query.evidence!,
          kind: query.kind!,
          ...(query.step !== undefined ? { step: query.step } : {}),
          ...(query.purpose !== undefined ? { purpose: query.purpose } : {}),
        },
        context,
      );
      return { output: formatFactOutcome(outcome) };
    }
  }
}

/** One line for the activity feed: what the call is doing, never the evidence. */
export function describeFactTableCall(args: JsonValue | undefined): string {
  const record =
    typeof args === "object" && args !== null && !Array.isArray(args) ? (args as JsonObject) : ({} as JsonObject);
  const claim = typeof record.claim === "string" ? clip(record.claim.trim(), 90) : "";
  switch (record.mode) {
    case "approve":
      return typeof record.factId === "string" ? `Asking the supreme judge to approve ${clip(record.factId, 30)}` : "Asking the supreme judge for badge approval";
    case "submit":
      return claim ? `Submitting a fact to the supreme judge — ${claim}` : "Submitting a fact to the supreme judge";
    case "status": {
      const ids = Array.isArray(record.ids) ? record.ids.filter((id): id is string => typeof id === "string") : [];
      return ids.length > 0 ? `Checking badges ${clip(ids.join(", "), 90)}` : "Checking the badges the chain cites";
    }
    default:
      return claim ? `Looking up the fact table — ${claim}` : "Looking up the fact table";
  }
}

/** Resolves the calling task's scope and task data on the run-global registration path. */
export type FactBindingResolver = (context: ToolExecutionContext) => FactTaskBinding | undefined;

/** The fact_table tool over a FactAccess, for registries that serve every task of a run. */
export function factTools(access: FactAccess, resolve: FactBindingResolver): readonly Tool[] {
  const tool: Tool = {
    definition: FACT_TABLE_DEFINITION,
    async execute(input, context) {
      const binding = resolve(context);
      if (binding === undefined || context.taskId === undefined) {
        return refusal("The fact table answers only inside a board task whose role may use it.");
      }
      return runFactTable(access, binding.scope, context.taskId, input, {
        ...binding.context,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
    },
  };
  return [tool];
}
