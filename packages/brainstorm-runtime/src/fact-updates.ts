/**
 * Fact updates, the runtime's side (spec/fact-updates.md v2 with the user's
 * decisions D1-D15 of 2026-10-14). When the run's fact table deletes a badge,
 * every subscriber is asked at once to reconsider what cites it: a seat whose
 * chain or developed output cites it, a critic whose unsettled report or
 * comment cites it, and the agent that submitted it (design section 3).
 *
 * - FactUpdateIndex: who subscribes to a badge, and the outputs the
 *   reconsideration tasks are built from. Kept current ONLY by deterministic
 *   folds (the chain and report stores, the merge points), so a replay
 *   rebuilds it exactly; it never reads the worker's spawner (risk 1).
 * - FactUpdateCoordinator: what the worker's spawner implements. The merge
 *   points call it live only; on replay their journaled output is folded.
 * - The hashes a task's base is recorded with, and the base check of 6.4.
 *
 * Everything here is inert unless the bundle's fact-table control declares
 * `updates: "delete-or-replace/v1"`.
 */
import { createHash } from "node:crypto";

import { factCitationsOf, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";

import { factIdsInValue } from "./game-ledger.js";

/** The control value that turns fact updates on (catalog/fact-table.json `updates`). */
export const FACT_UPDATES_RULE = "delete-or-replace/v1";

/** The merge handlers of the workflow (design 6.3, 11.15) and the merge point each one is. */
export const FACT_MERGE_HANDLERS = {
  "facts.mergeChain": "chain",
  "facts.mergeGameReports": "game-reports",
  "facts.mergeLateGameReports": "late-game-reports",
  "facts.mergeComments": "comments",
  "facts.mergeLateComments": "late-comments",
  "facts.mergeIdeas": "ideas",
  "facts.closeUpdates": "close",
} as const;

export type FactMergeHandler = keyof typeof FACT_MERGE_HANDLERS;
export type FactMergePoint = (typeof FACT_MERGE_HANDLERS)[FactMergeHandler];

export function isFactMergeHandler(name: string): name is FactMergeHandler {
  return Object.prototype.hasOwnProperty.call(FACT_MERGE_HANDLERS, name);
}

/** The roles whose submissions map onto a seat's chain, a game report, or a comment (design 3.1). */
const CHAIN_SUBMITTERS: ReadonlySet<string> = new Set(["brain", "redeveloper", "game-redeveloper", "reconsider-chain"]);
const GAME_REPORT_SUBMITTERS: ReadonlySet<string> = new Set(["game-commentor", "game-interdisciplinary-commentor", "reconsider-game-report"]);
const COMMENT_SUBMITTERS: ReadonlySet<string> = new Set(["commentor", "interdisciplinary-commentor", "reconsider-comment"]);

export type FactSubscriberKind = "chain" | "game-report" | "comment";

export interface FactSubscriberKey {
  readonly kind: FactSubscriberKind;
  readonly seat: string;
  readonly step?: number;
  readonly round?: number;
  readonly critic?: string;
}

/** A seat's chain: `chain:<seat>`. */
export function chainSubscriberKey(seat: string): string {
  return `chain:${seat}`;
}

/** An unsettled report or comment: `<kind>:<seat>:<step>:<round>:<critic>`. */
export function reportSubscriberKey(kind: "game-report" | "comment", seat: string, step: number, round: number, critic: string): string {
  return `${kind}:${seat}:${step}:${round}:${critic}`;
}

/** The parts of a subscriber key; member ids never contain a colon. */
export function parseSubscriberKey(key: string): FactSubscriberKey | undefined {
  const parts = key.split(":");
  const kind = parts[0];
  if (kind === "chain" && parts.length === 2 && parts[1] !== "") return { kind, seat: parts[1]! };
  if ((kind === "game-report" || kind === "comment") && parts.length === 5) {
    const step = Number(parts[2]);
    const round = Number(parts[3]);
    if (parts[1] !== "" && parts[4] !== "" && Number.isSafeInteger(step) && step >= 1 && Number.isSafeInteger(round) && round >= 1) {
      return { kind, seat: parts[1]!, step, round, critic: parts[4]! };
    }
  }
  return undefined;
}

/** The round a report key belongs to: `<kind>:<seat>:<step>:<round>`. */
export function roundOfReportKey(key: string): string | undefined {
  const parsed = parseSubscriberKey(key);
  return parsed === undefined || parsed.kind === "chain" ? undefined : `${parsed.kind}:${parsed.seat}:${parsed.step}:${parsed.round}`;
}

/** sha256 of a JSON value, as a task's base records what it saw. */
export function factUpdateDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")}`;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a chain reconsideration saw, hashed (design 6.1 `base`): every step,
 * every developed section by shape key and section name, the requested
 * sections and the novelty.
 */
export function chainBase(idea: JsonObject): JsonObject {
  const steps: Record<string, string> = {};
  (Array.isArray(idea.cot) ? idea.cot : []).forEach((step, index) => {
    steps[String(index + 1)] = factUpdateDigest(step);
  });
  const sections: Record<string, string> = {};
  const output = isRecord(idea.output) ? idea.output : {};
  for (const [shape, body] of Object.entries(output)) {
    if (shape === "type") continue;
    if (shape === "requested") {
      sections.requested = factUpdateDigest(body);
      continue;
    }
    if (isRecord(body)) {
      for (const [name, text] of Object.entries(body)) sections[`${shape}.${name}`] = factUpdateDigest(text);
    }
  }
  if (idea.novelty !== undefined) sections.novelty = factUpdateDigest(idea.novelty);
  return { steps, sections };
}

/** What a report or comment reconsideration saw, hashed. */
export function reportBase(report: JsonValue): JsonObject {
  return { report: factUpdateDigest(report) };
}

/**
 * The base check (design 6.4, P7): the steps and sections a revision rewrites
 * whose current text no longer hashes to what the task saw. Parts the
 * revision does not touch may have changed freely.
 */
export function staleChainParts(idea: JsonObject, base: JsonValue, revision: JsonValue): string[] {
  if (!isRecord(revision) || revision.decision !== "revised") return [];
  const seen = isRecord(base) ? base : {};
  const seenSteps = isRecord(seen.steps) ? seen.steps : {};
  const seenSections = isRecord(seen.sections) ? seen.sections : {};
  const now = chainBase(idea);
  const nowSteps = now.steps as JsonObject;
  const nowSections = now.sections as JsonObject;
  const stale: string[] = [];
  for (const step of Array.isArray(revision.steps) ? revision.steps : []) {
    const index = isRecord(step) ? String(step.index) : "";
    if (nowSteps[index] !== seenSteps[index]) stale.push(`step ${index}`);
  }
  const patch = isRecord(revision.outputPatch) ? revision.outputPatch : {};
  for (const [shape, body] of Object.entries(patch)) {
    if (shape === "requested") {
      if (nowSections.requested !== seenSections.requested) stale.push("requested");
      continue;
    }
    for (const name of isRecord(body) ? Object.keys(body) : []) {
      const key = `${shape}.${name}`;
      if (nowSections[key] !== seenSections[key]) stale.push(key);
    }
  }
  if (revision.novelty !== undefined && nowSections.novelty !== seenSections.novelty) stale.push("novelty");
  return stale;
}

/** The chain steps (1-based) of `chain` that cite `factId`. */
export function citedSteps(chain: JsonValue | undefined, factId: string): number[] {
  return factCitationsOf(chain).filter((citation) => citation.ids.includes(factId)).map((citation) => citation.step);
}

/** One notice (design 4.1) as the spawner journals it and a task receives it. */
export interface FactNotice {
  readonly notice: string;
  readonly deleted: string;
  readonly claim: string;
  readonly conditions: string;
  readonly reason: string;
  readonly replacement?: {
    readonly id: string;
    readonly status: string;
    readonly claim: string;
    readonly conditions: string;
    readonly reason: string;
  };
  /** Per subscriber: the chain or reviewed-prefix steps that cite the deleted id; omitted when none does. */
  readonly citedAt?: readonly number[];
}

/** A report or comment the index holds until its round's late merge closes it. */
export interface FactIndexedReport {
  readonly key: string;
  readonly kind: "game-report" | "comment";
  readonly seat: string;
  readonly step: number;
  readonly round: number;
  readonly critic: string;
  /** The stored gameCritique or commentParts. */
  readonly report: JsonObject;
  /** The reviewed chain prefix the report was written on. */
  readonly prefix: readonly JsonValue[];
  /** Game reports: the deletion epoch the report (or its revision) was requested at. */
  readonly epoch?: number;
  /** Comments: the round's allowed verdicts. */
  readonly allowedVerdicts?: readonly string[];
  /** open: before the report merge; chair: with the chair or judge; closed: after the late merge. */
  readonly phase: "open" | "chair" | "closed";
}

/** One subscriber of a deleted badge (design 3.1). */
export interface FactUpdateSubscriber {
  readonly key: string;
  readonly kind: FactSubscriberKind;
  readonly seat: string;
  /** The seat (chain) or the critic. */
  readonly agent: string;
  readonly step?: number;
  readonly round?: number;
  readonly citedAt: readonly number[];
}

/** The submitter of a deleted entry as the table recorded it (its first requester). */
export interface FactUpdateSubmitter {
  readonly role: string;
  readonly agent: string;
  readonly seat?: string;
  readonly step?: number;
}

export interface FactSubscribers {
  readonly subscribers: readonly FactUpdateSubscriber[];
  /** The submitter when it has no revisable output (P9): `none:<role>:<agent>`. */
  readonly none?: string;
}

/** The run data a reconsideration task is built from. */
export interface FactUpdateRunData {
  readonly input?: JsonValue;
  readonly files?: JsonValue;
  readonly panel?: JsonValue;
}

interface RunIndex {
  data: FactUpdateRunData;
  readonly ideas: Map<string, JsonObject>;
  readonly reports: Map<string, FactIndexedReport>;
  /** Per key, the notices a merge point merged or discarded. */
  readonly consumed: Map<string, Set<string>>;
  readonly consumedTasks: Set<string>;
  /** `<kind>:<seat>:<step>:<round>` of every round whose late merge has folded. */
  readonly closedRounds: Set<string>;
  closed: boolean;
}

/**
 * The run-global subscriber index (design 3.2): per run, every seat's latest
 * idea, every unsettled report and comment, the run data, and what the merge
 * points have consumed. Owned by the compiled workflow like the game ledger;
 * written only by folds.
 */
export class FactUpdateIndex {
  private readonly runs = new Map<string, RunIndex>();

  constructor(private readonly dismissed: ReadonlySet<string> = new Set()) {}

  private run(runId: string): RunIndex {
    let run = this.runs.get(runId);
    if (run === undefined) {
      run = { data: {}, ideas: new Map(), reports: new Map(), consumed: new Map(), consumedTasks: new Set(),
        closedRounds: new Set(), closed: false };
      this.runs.set(runId, run);
    }
    return run;
  }

  /**
   * The run data, from the state a fold sees. Kept by reference: the run
   * state is copy-on-write, so a value a fold saw is never changed in place.
   */
  noteRunData(runId: string, state: JsonObject): void {
    const files = isRecord(state.usefulFiles) ? state.usefulFiles.files : undefined;
    this.run(runId).data = {
      ...(state.input !== undefined ? { input: state.input } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(state.panel !== undefined ? { panel: state.panel } : {}),
    };
  }

  setIdea(runId: string, seat: string, idea: JsonObject): void {
    this.run(runId).ideas.set(seat, structuredClone(idea));
  }

  openReport(runId: string, report: Omit<FactIndexedReport, "phase">): void {
    const run = this.run(runId);
    const round = roundOfReportKey(report.key);
    run.reports.set(report.key, { ...structuredClone(report), phase: round !== undefined && run.closedRounds.has(round) ? "closed" : "open" });
  }

  /** A revision merged in place of a report; a game report takes its task's epoch. */
  reviseReport(runId: string, key: string, report: JsonObject, epoch?: number): void {
    const run = this.run(runId);
    const known = run.reports.get(key);
    if (known === undefined) return;
    run.reports.set(key, { ...known, report: structuredClone(report), ...(epoch !== undefined ? { epoch } : {}) });
  }

  withdrawReport(runId: string, key: string): void {
    this.run(runId).reports.delete(key);
  }

  /** The round's report merge has folded: its reports are with the chair or judge. */
  passToChair(runId: string, kind: "game-report" | "comment", seat: string, step: number, round: number): void {
    const run = this.run(runId);
    for (const [key, report] of run.reports) {
      if (report.kind === kind && report.seat === seat && report.step === step && report.round === round && report.phase === "open") {
        run.reports.set(key, { ...report, phase: "chair" });
      }
    }
  }

  /** The round's late merge has folded: its reports are closed. */
  closeRound(runId: string, kind: "game-report" | "comment", seat: string, step: number, round: number): void {
    const run = this.run(runId);
    run.closedRounds.add(`${kind}:${seat}:${step}:${round}`);
    for (const [key, report] of run.reports) {
      if (report.kind === kind && report.seat === seat && report.step === step && report.round === round) {
        run.reports.set(key, { ...report, phase: "closed" });
      }
    }
  }

  /** `apply-fact-updates-before-synthesis` has folded: no new task for this run. */
  closeRun(runId: string): void {
    this.run(runId).closed = true;
  }

  /** What one merge point merged and discarded (a factUpdateMerge value). */
  noteMerge(runId: string, merge: JsonValue | undefined): void {
    if (!isRecord(merge)) return;
    const run = this.run(runId);
    for (const list of [merge.merged, merge.discarded]) {
      for (const item of Array.isArray(list) ? list : []) {
        if (!isRecord(item) || typeof item.key !== "string") continue;
        if (typeof item.taskId === "string") run.consumedTasks.add(item.taskId);
        const notices = run.consumed.get(item.key) ?? new Set<string>();
        for (const notice of Array.isArray(item.notices) ? item.notices : []) if (typeof notice === "string") notices.add(notice);
        run.consumed.set(item.key, notices);
      }
    }
  }

  runData(runId: string): FactUpdateRunData {
    return this.runs.get(runId)?.data ?? {};
  }

  idea(runId: string, seat: string): JsonObject | undefined {
    return this.runs.get(runId)?.ideas.get(seat);
  }

  seats(runId: string): string[] {
    return [...(this.runs.get(runId)?.ideas.keys() ?? [])];
  }

  report(runId: string, key: string): FactIndexedReport | undefined {
    return this.runs.get(runId)?.reports.get(key);
  }

  /** The unsettled reports of one round (any phase but closed). */
  roundReports(runId: string, kind: "game-report" | "comment", seat: string, step: number, round: number): FactIndexedReport[] {
    return [...(this.runs.get(runId)?.reports.values() ?? [])].filter((report) =>
      report.kind === kind && report.seat === seat && report.step === step && report.round === round && report.phase !== "closed");
  }

  isClosed(runId: string): boolean {
    return this.runs.get(runId)?.closed === true;
  }

  isRoundClosed(runId: string, key: string): boolean {
    const round = roundOfReportKey(key);
    return round !== undefined && this.runs.get(runId)?.closedRounds.has(round) === true;
  }

  isDismissed(seat: string): boolean {
    return this.dismissed.has(seat);
  }

  consumedNotices(runId: string, key: string): ReadonlySet<string> {
    return this.runs.get(runId)?.consumed.get(key) ?? new Set();
  }

  isTaskConsumed(runId: string, taskId: string): boolean {
    return this.runs.get(runId)?.consumedTasks.has(taskId) === true;
  }

  /**
   * Of `deletions`, the ids the current output of `key` cites (detection
   * paths 2 and 3, design 3.4): a seat's chain, developed output or novelty,
   * or an unsettled report, a game report only for a deletion after it was
   * requested (P3). Nothing for a dismissed seat or a closed report.
   */
  citedBy(runId: string, key: string, deletions: readonly { readonly id: string; readonly seq: number }[]): string[] {
    const parsed = parseSubscriberKey(key);
    if (parsed === undefined || this.dismissed.has(parsed.seat)) return [];
    if (parsed.kind === "chain") {
      const idea = this.idea(runId, parsed.seat);
      if (idea === undefined) return [];
      const ids = factIdsInValue({ cot: idea.cot ?? null, output: idea.output ?? null, novelty: idea.novelty ?? null });
      return deletions.filter((deletion) => ids.includes(deletion.id)).map((deletion) => deletion.id);
    }
    const report = this.report(runId, key);
    if (report === undefined || report.phase === "closed" || this.dismissed.has(report.critic)) return [];
    const ids = factIdsInValue(report.report);
    return deletions
      .filter((deletion) => ids.includes(deletion.id) &&
        !(report.kind === "game-report" && report.epoch !== undefined && report.epoch >= deletion.seq))
      .map((deletion) => deletion.id);
  }

  /**
   * The subscribers of a deleted badge (design 3.1): every seat whose idea
   * cites it; every unsettled report or comment that cites it, a game report
   * only when it was requested before the deletion (its epoch is below the
   * deletion's sequence, P3); and the entry's submitter, mapped by role onto
   * its chain or its unsettled report or comment. Dismissed seats never
   * subscribe. A submitter with no revisable output is returned as `none`.
   */
  subscribersOf(runId: string, factId: string, submitter: FactUpdateSubmitter | undefined, seq: number): FactSubscribers {
    const run = this.runs.get(runId);
    const found = new Map<string, FactUpdateSubscriber>();
    let submitterMapped = false;
    if (run !== undefined) {
      for (const [seat, idea] of run.ideas) {
        if (this.dismissed.has(seat)) continue;
        const cites = factIdsInValue({ cot: idea.cot ?? null, output: idea.output ?? null, novelty: idea.novelty ?? null }).includes(factId);
        const submitted = submitter !== undefined && CHAIN_SUBMITTERS.has(submitter.role) && (submitter.seat ?? submitter.agent) === seat;
        if (submitted) submitterMapped = true;
        if (!cites && !submitted) continue;
        const key = chainSubscriberKey(seat);
        found.set(key, { key, kind: "chain", seat, agent: seat, citedAt: citedSteps(idea.cot, factId) });
      }
      for (const report of run.reports.values()) {
        if (report.phase === "closed" || this.dismissed.has(report.seat) || this.dismissed.has(report.critic)) continue;
        if (report.kind === "game-report" && report.epoch !== undefined && report.epoch >= seq) continue;
        const roles = report.kind === "game-report" ? GAME_REPORT_SUBMITTERS : COMMENT_SUBMITTERS;
        const submitted = submitter !== undefined && roles.has(submitter.role) && submitter.agent === report.critic &&
          submitter.seat === report.seat && submitter.step === report.step;
        if (submitted) submitterMapped = true;
        if (!submitted && !factIdsInValue(report.report).includes(factId)) continue;
        found.set(report.key, { key: report.key, kind: report.kind, seat: report.seat, agent: report.critic,
          step: report.step, round: report.round, citedAt: citedSteps(report.prefix as JsonValue, factId) });
      }
    }
    return {
      subscribers: [...found.values()],
      ...(submitter !== undefined && !submitterMapped ? { none: `none:${submitter.role}:${submitter.agent}` } : {}),
    };
  }
}

/** A merge point's request (live only). */
export interface FactMergeRequest {
  readonly runId: string;
  readonly nodePath: string;
  readonly point: FactMergePoint;
  /** The seat of a seat-level merge point. */
  readonly seat?: string;
  /** The walk position and round of a report or comment merge point. */
  readonly step?: number;
  readonly round?: number;
  readonly signal: AbortSignal;
}

/** An output stored by a task that ran in this process (detection path 2, design 3.4). */
export interface FactStoredOutput {
  readonly runId: string;
  readonly key: string;
}

/**
 * The worker's spawner (apps/worker/src/fact-updates.ts), as the runtime
 * calls it. `merge` waits for the tasks a merge point needs and returns its
 * factUpdateMerge value; it runs live only, never on replay.
 */
export interface FactUpdateCoordinator {
  merge(request: FactMergeRequest): Promise<JsonObject>;
  stored(output: FactStoredOutput): void;
  /**
   * Binds the reconsideration tasks to one run invocation's abort signal
   * (decision D16): when it aborts, because the run was cancelled or ended
   * failed, the running tasks abort, and a resume runs them again at their
   * next merge point (D10).
   */
  bindRun?(signal: AbortSignal): void;
}

/** The empty merge: nothing pending at this point. */
export function emptyFactUpdateMerge(point: FactMergePoint): JsonObject {
  return { merged: [], discarded: [], ...(point === "late-game-reports" || point === "late-comments" ? { reassess: false } : {}) };
}
