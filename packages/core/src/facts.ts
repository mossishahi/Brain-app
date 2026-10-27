/**
 * The run's fact table: the justification badges the board's facts rest on.
 *
 * Whenever a seat wants to rely on a fact — about the attached code, the
 * run's own record, an empirical result, the literature, or mathematics — it
 * obtains a justification badge when it asserts an independent substantive
 * claim; directly inspectable reasoning needs no separate badge. It asks the
 * supreme judge whether a badge already covers the claim conceptually; when
 * none does, it submits the fact with its own justification, and the supreme
 * judge — the verifier role behind the table, which re-checks the claim with
 * its own tools — rules on it. A justified fact enters the table under the
 * conditions it was verified under, so the next seat that needs it finds it
 * instead of re-checking it. A submission that contradicts an entry is
 * examined against that entry in BOTH directions: the table's entry is not
 * automatically right, and a ruling may revoke it, narrow it, or leave both
 * disputed.
 *
 * Seats cite the badges they rely on inline as `[F:n]`. The runtime reads
 * those citations out of the chain each review task is shown, so a reviewer
 * can ask for the standing of every badge the chain stands on in one call and
 * see at once which were revoked, disputed or narrowed since.
 *
 * This module is the contract between the three parties:
 * - the worker, which owns the run's table (an append-only log in the session
 *   directory), runs the supreme judge, and implements FactAccess;
 * - the runtime, which stamps every task whose role declares the `fact-table`
 *   capability with the FactScope it acts in (task.metadata.factScope);
 * - the tool (host-tools: fact_table), which parses the agent's request,
 *   routes new-bundle consultations to the supreme judge. Legacy pinned
 *   bundles retain deterministic host-side lookups and status reads.
 *
 * Blindness: no answer ever says who submitted, relied on, or challenged an
 * entry. Requesters are recorded for the board's own audit and never shown to
 * an agent.
 */
import { createHash } from "node:crypto";
import type { AgentExecutionContext, AgentTask } from "./agent/contracts.js";
import type { JsonObject, JsonValue } from "./types/json.js";

/** What a submitted fact is about; it decides how the supreme judge checks it. */
export type FactKind = "code" | "record" | "result" | "literature" | "math" | "background";
export const FACT_KINDS: readonly FactKind[] = ["code", "record", "result", "literature", "math", "background"];

/**
 * The answer one submission receives (catalog/fact-table.json defines each):
 * - "justified": an entry already covers the claim; the answer names it.
 * - "justified-new": verified now; a new badge enters the table.
 * - "narrowed": true only under narrower conditions; a badge for the narrowed claim enters the table.
 * - "conflict": it contradicts an entry that stands (or the two could not be told apart): no badge.
 * - "refuted": the evidence shows it is false; recorded as refuted, no badge.
 * - "unverified": it could not be checked with the verifier's tools or time; no badge.
 * - "not-a-fact": no separately asserted factual claim needs verification (for example,
 *   a definition, preference, or directly inspectable inference from established premises).
 *   This supplies no badge and does not certify truth. Substantive mathematical results
 *   and context-sensitive background claims can be verified; their labels do not exempt them.
 */
export type FactCase =
  | "justified"
  | "justified-new"
  | "narrowed"
  | "conflict"
  | "refuted"
  | "unverified"
  | "not-a-fact";
export const FACT_CASES: readonly FactCase[] = [
  "justified",
  "justified-new",
  "narrowed",
  "conflict",
  "refuted",
  "unverified",
  "not-a-fact",
];

/** How the supreme judge checked a claim; "none" only when nothing could be checked. */
export type FactMethod = "re-executed" | "source-quoted" | "record-match" | "judgement-only" | "none";
export const FACT_METHODS: readonly FactMethod[] = [
  "re-executed",
  "source-quoted",
  "record-match",
  "judgement-only",
  "none",
];

/**
 * What a submission's ruling did to an entry it contradicted:
 * - "incumbent-stands": the entry holds and the submission is rejected (case "conflict").
 * - "incumbent-revoked": the entry is wrong; it is revoked and the submission's badge supersedes it.
 * - "both-narrowed": both hold under different conditions; the entry keeps narrower conditions.
 * - "disputed": neither could be settled; both are marked disputed and nobody may rely on either.
 */
export type FactResolution = "incumbent-stands" | "incumbent-revoked" | "both-narrowed" | "disputed";
export const FACT_RESOLUTIONS: readonly FactResolution[] = [
  "incumbent-stands",
  "incumbent-revoked",
  "both-narrowed",
  "disputed",
];

/** Whether the submitted justification itself was honest (recorded against the submitter, never shown to others). */
export type FactIntegrity = "honest" | "unsupported" | "misrepresented" | "fabricated";
export const FACT_INTEGRITY: readonly FactIntegrity[] = ["honest", "unsupported", "misrepresented", "fabricated"];

/** An entry's standing. Only a "justified" entry is a badge an agent may rely on. */
export type FactStatus = "justified" | "disputed" | "revoked" | "refuted";
export const FACT_STATUSES: readonly FactStatus[] = ["justified", "disputed", "revoked", "refuted"];

/** The id of a table entry: "F:" and a positive integer. Submissions are numbered "S:n". */
export const FACT_ID_PATTERN = /^F:[1-9][0-9]*$/;

export function isFactId(value: unknown): value is string {
  return typeof value === "string" && FACT_ID_PATTERN.test(value);
}

/** The badges one chain step cites inline as `[F:n]`. */
export interface FactCitation {
  readonly step: number;
  readonly ids: readonly string[];
}

/**
 * Who is asking, stamped per task by the runtime (task.metadata.factScope) on
 * every task whose role declares the `fact-table` capability.
 */
export interface FactScope {
  /** The role (skill) of the asking task, e.g. "commentor". */
  readonly role: string;
  /** The asking agent: a commentor id, a panel member id, or the role itself. */
  readonly agent: string;
  /** The seat (panel member id) whose chain the task works on, when there is one. */
  readonly seat?: string;
  /** The chain position (1-based) the task works at, when there is one. */
  readonly step?: number;
  /** The badges cited in the chain the task was shown, step by step. */
  readonly cited?: readonly FactCitation[];
  /** Runtime-owned review group: critics share a frozen starting view, not live peer updates. */
  readonly blindReview?: string;
}

/** A requester as the table records it: the scope and the task. Never shown to an agent. */
export interface FactRequester {
  readonly taskId: string;
  readonly role: string;
  readonly agent: string;
  readonly seat?: string;
  readonly step?: number;
}

/** One event in an entry's life, as agents may see it (it never names a requester). */
export interface FactEvent {
  readonly at: number;
  readonly event: "issued" | "relied" | "upheld" | "narrowed" | "revoked" | "disputed" | "refuted";
  /** The entry or submission that caused it, e.g. "F:12" or "S:30". */
  readonly by?: string;
  readonly detail?: string;
}

/** One entry of the table. */
export interface FactEntry {
  readonly id: string;
  /** Hash of this immutable verified-content revision; never semantic identity. */
  readonly badgeHash?: string;
  readonly status: FactStatus;
  readonly kind: FactKind;
  /** The fact as the supreme judge stated it: one self-contained sentence. */
  readonly claim: string;
  /** The conditions it holds under ("none" when unconditional). */
  readonly conditions: string;
  readonly method: FactMethod;
  /** What the supreme judge did and found: the script and its output, the quote and its source, the file and line. */
  readonly evidence: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The entry that superseded this one when it was revoked. */
  readonly supersededBy?: string;
  readonly history: readonly FactEvent[];
  /** Internal audit only: every requester that obtained or relied on this entry. Never rendered to an agent. */
  readonly requesters: readonly FactRequester[];
}

/** What an agent submits for verification. */
export interface FactSubmission {
  readonly claim: string;
  readonly conditions: string;
  readonly evidence: string;
  readonly kind: FactKind;
  /** The chain step the fact supports (thinker) or the step under review (reviewer). */
  readonly step?: number;
  /** What the requester's reasoning builds on the fact. */
  readonly purpose?: string;
}

/** One contradicted entry in the supreme judge's verdict. */
export interface FactConflictRuling {
  readonly id: string;
  readonly resolution: FactResolution;
  /** For "both-narrowed": the conditions the existing entry holds under from now on. */
  readonly conditions?: string;
  readonly explanation: string;
}

/** The supreme judge's structured verdict (artifact schema `factVerdict`). */
export interface FactVerdict {
  readonly case: FactCase;
  /** The claim as checked: for "narrowed", the narrowed claim. */
  readonly claim: string;
  readonly conditions: string;
  readonly method: FactMethod;
  readonly evidence: string;
  /** Addressed to the requester: what was found and why the case follows. */
  readonly explanation: string;
  /** For "justified": the entry that already covers the claim. */
  readonly existing?: string;
  readonly conflicts: readonly FactConflictRuling[];
  readonly integrity: FactIntegrity;
}

/** The task data a submission travels with: what the verifier may need from the requester's task. */
export interface FactSubmitContext {
  /** The requester's `input` binding (the structured submission the board works on). */
  readonly input?: JsonValue;
  /** The requester's `files` binding (the file map the verifier reads attachments through). */
  readonly files?: JsonValue;
  /** The requester's execution context (run id, node path). */
  readonly execution?: AgentExecutionContext;
  readonly signal?: AbortSignal;
  /** Host-derived from the actual committee task, never from tool input. */
  readonly review?: FactReviewBinding;
}

export interface FactReviewBinding {
  readonly chairTaskId: string;
  readonly reviewVersion: string;
  readonly reports: Readonly<Record<string, { readonly reportHash: string; readonly justification: string }>>;
  /**
   * A re-assessment of a round after a fact-table deletion (decisions D4,
   * D12): the chair tasks that assessed the same round before this one. An
   * approval one of them obtained for an unchanged report and badge is
   * returned again without a new consultation. Host-derived from the task's
   * metadata (`factReview`), never from tool input.
   */
  readonly earlierChairTaskIds?: readonly string[];
}

export interface FactConsultQuery {
  readonly mode: "lookup" | "status" | "submit" | "approve";
  readonly claim?: string;
  readonly conditions?: string;
  readonly evidence?: string;
  readonly kind?: FactKind;
  readonly step?: number;
  readonly purpose?: string;
  readonly ids?: readonly string[];
  readonly max_results?: number;
  readonly message?: string;
  readonly factId?: string;
  readonly badgeHash?: string;
  readonly criticId?: string;
}

export interface FactConsultation {
  readonly answer: string;
  readonly matches: readonly {
    readonly factId: string;
    readonly relation: "equivalent" | "supports" | "conflicts" | "related";
    readonly reason: string;
  }[];
  readonly approval?: { readonly approved: boolean; readonly targetFactId?: string; readonly reason: string };
}

export interface FactUseApproval {
  readonly id: string;
  readonly requesterTaskId: string;
  readonly reviewVersion: string;
  readonly reportHash: string;
  readonly criticId: string;
  readonly citedBadgeId: string;
  readonly citedBadgeHash: string;
  readonly targetBadgeId: string;
  readonly targetBadgeHash: string;
  readonly targetStandingRevision: string;
  readonly approved: boolean;
  readonly reason: string;
}

export interface FactEvidenceSnapshot {
  readonly facts: readonly FactEntry[];
  readonly approvals: readonly FactUseApproval[];
  /** Every deletion from the table, in deletion order; present when the control declares fact updates. */
  readonly deletions?: readonly FactDeletion[];
}

/**
 * One deletion from the table (control `updates: "delete-or-replace/v1"`). A
 * revoked entry leaves the table, and its log keeps only this one-line marker:
 * the id, the run's deletion sequence (1 + the deletions recorded before it,
 * the deletion epoch), the time, and the badge the same ruling issued in its
 * place. Neither the claim nor any reason is kept with it.
 */
export interface FactDeletion {
  readonly id: string;
  readonly seq: number;
  readonly at: number;
  readonly replacedBy?: string;
}

/** What the shared table tells its update listener once a deletion is durable. */
export interface FactUpdateEvent {
  readonly deletion: FactDeletion;
  /** The deleted entry as it stood before the ruling; its claim and conditions reach agents only in a notice. */
  readonly entry: FactEntry;
  /** The supreme judge's explanation of the ruling on the deleted entry (the verdict's conflict explanation). */
  readonly reason: string;
  /** The badge the same ruling issued, as it stands. */
  readonly replacement?: FactEntry;
  /** The submission whose ruling deleted the entry, "S:n". */
  readonly submission: string;
}

/** Called once per durable deletion from the shared table. */
export type FactUpdateListener = (event: FactUpdateEvent) => void;

const factDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function factIssuanceReason(entry: FactEntry): string {
  return entry.history.find((event) => event.event === "issued" || event.event === "refuted")?.detail ?? "";
}

export function factBadgeHash(entry: FactEntry): string {
  return `sha256:${factDigest({ id: entry.id, kind: entry.kind, claim: entry.claim, conditions: entry.conditions,
    method: entry.method, evidence: entry.evidence, reason: factIssuanceReason(entry) })}`;
}

export function factStandingRevision(entry: FactEntry): string {
  return factDigest({ badgeHash: factBadgeHash(entry), status: entry.status,
    history: entry.history.filter((event) => event.event !== "relied") });
}

export function factReportHash(report: { readonly q: number; readonly justification: string }): string {
  return factDigest({ q: report.q, justification: report.justification });
}

/** Shared with runtime scoring so approvals bind the identical reviewed prefix. */
export function factReviewVersion(chain: JsonValue, currentStep: number): string {
  return factDigest({ currentStep, chain });
}

/**
 * The alert a `status` answer gives for a requested badge the table deleted
 * (control `updates`). One text for the legacy tool and the worker's mediated
 * answer, so both say exactly the same.
 */
export function factDeletionAlert(deletion: { readonly id: string; readonly replacedBy?: string }): string {
  return deletion.replacedBy !== undefined
    ? `${deletion.id} was deleted from the fact table and replaced by ${deletion.replacedBy}: nothing may cite ${deletion.id} as support; check whether ${deletion.replacedBy} covers the citing claim within its conditions.`
    : `${deletion.id} was deleted from the fact table: nothing may cite it as support.`;
}

/** A contradicted entry as it stands after the ruling. */
export interface FactConflictOutcome {
  readonly entry: FactEntry;
  readonly resolution: FactResolution;
  readonly explanation: string;
  /** The ruling deleted this entry from the table; `entry` is the entry as it stood. */
  readonly deleted?: boolean;
}

/** The committed result of one submission. */
export interface FactSubmissionOutcome {
  /** The submission's own id, "S:n". */
  readonly submission: string;
  readonly case: FactCase;
  /** The badge the requester may now cite: the existing entry (justified) or the new one (justified-new, narrowed). */
  readonly badge?: FactEntry;
  /** The verdict as the supreme judge gave it; absent when the submission was refused before any check. */
  readonly verdict?: FactVerdict;
  readonly conflicts: readonly FactConflictOutcome[];
  /** The entries the submission itself added that are not badges: a refuted claim, or a disputed counter-claim. */
  readonly recorded?: FactEntry;
  /** Why the submission was not verified at all (limit reached, verifier failed); `case` is then "unverified". */
  readonly refusal?: string;
}

/** Budgets of the fact table (catalog/fact-table.json `limits`). */
export interface FactTableLimits {
  /** Submissions one task may make; consultations do not consume this quota. */
  readonly submissionsPerTask: number;
  /** Semantic scan batch size in mediated mode; lexical shortlist size in legacy mode. */
  readonly relatedFacts: number;
  /** Entries a lookup returns by default. */
  readonly lookupResults: number;
  /** Wall-clock ceiling of one verification. */
  readonly verificationMinutes: number;
}

export const DEFAULT_FACT_TABLE_LIMITS: FactTableLimits = {
  submissionsPerTask: 6,
  relatedFacts: 8,
  lookupResults: 5,
  verificationMinutes: 30,
};

/** The run's fact table, implemented by the worker. */
export interface FactAccess {
  readonly accessMode?: "supreme-mediated/v1";
  consult?(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext): Promise<JsonObject>;
  evidence?(): Promise<FactEvidenceSnapshot>;
  /** Select a task's isolated view when its runtime scope requests blind review. */
  forTask?(taskId: string, scope: FactScope): Promise<FactAccess>;
  /** Every entry as it stands now, in id order (a consistent snapshot). */
  entries(signal?: AbortSignal): Promise<readonly FactEntry[]>;
  /** The deletions from the table, in deletion order (control `updates`); absent on tables without them. */
  deletions?(signal?: AbortSignal): Promise<readonly FactDeletion[]>;
  /** Verifies and records one submission; resolves once its ruling is committed. */
  submit(
    requester: FactRequester,
    submission: FactSubmission,
    context: FactSubmitContext,
  ): Promise<FactSubmissionOutcome>;
}

/** Where a task's `metadata.factScope` is read from, when it carries a valid one. */
export function factScopeOf(metadata: unknown): FactScope | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const raw = (metadata as { factScope?: unknown }).factScope;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { role, agent, seat, step, cited, blindReview } = raw as {
    role?: unknown;
    agent?: unknown;
    seat?: unknown;
    step?: unknown;
    cited?: unknown;
    blindReview?: unknown;
  };
  if (typeof role !== "string" || role === "" || typeof agent !== "string" || agent === "") return undefined;
  if (seat !== undefined && (typeof seat !== "string" || seat === "")) return undefined;
  if (step !== undefined && !(typeof step === "number" && Number.isSafeInteger(step) && step >= 1)) return undefined;
  if (blindReview !== undefined && (typeof blindReview !== "string" || blindReview.length === 0)) return undefined;
  let citations: FactCitation[] | undefined;
  if (cited !== undefined) {
    if (!Array.isArray(cited)) return undefined;
    citations = [];
    for (const entry of cited) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const { step: citedStep, ids } = entry as { step?: unknown; ids?: unknown };
      if (!(typeof citedStep === "number" && Number.isSafeInteger(citedStep) && citedStep >= 1)) return undefined;
      if (!Array.isArray(ids) || !ids.every(isFactId)) return undefined;
      citations.push({ step: citedStep, ids: [...(ids as string[])] });
    }
  }
  return {
    role,
    agent,
    ...(seat !== undefined ? { seat: seat as string } : {}),
    ...(step !== undefined ? { step: step as number } : {}),
    ...(citations !== undefined ? { cited: citations } : {}),
    ...(blindReview !== undefined ? { blindReview: blindReview as string } : {}),
  };
}

/** The requester record of a task acting in `scope`. */
export function factRequesterOf(scope: FactScope, taskId: string): FactRequester {
  return {
    taskId,
    role: scope.role,
    agent: scope.agent,
    ...(scope.seat !== undefined ? { seat: scope.seat } : {}),
    ...(scope.step !== undefined ? { step: scope.step } : {}),
  };
}

/**
 * Every badge id cited in `text`, in order of first appearance, without
 * repeats. A citation is `[F:n]`; one bracket may list several, separated by
 * commas or semicolons (`[F:3, F:7]`).
 */
export function factIdsIn(text: string): readonly string[] {
  const ids: string[] = [];
  for (const group of text.matchAll(/\[\s*(F:[1-9][0-9]*(?:\s*[,;]\s*F:[1-9][0-9]*)*)\s*\]/g)) {
    for (const part of group[1]!.split(/[,;]/)) {
      const id = part.trim();
      if (isFactId(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function textOf(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (depth > 3 || typeof value !== "object" || value === null) return "";
  const parts = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return parts.map((part) => textOf(part, depth + 1)).filter((part) => part !== "").join("\n");
}

/**
 * The `[F:n]` citations of a chain binding, step by step: `chain` is the
 * array of steps a task was shown (four-part objects or paragraph strings).
 * A step's number is its own `step`/`index` field when it carries one, its
 * 1-based position otherwise. Steps that cite nothing are left out.
 */
export function factCitationsOf(chain: unknown): readonly FactCitation[] {
  if (!Array.isArray(chain)) return [];
  const citations: FactCitation[] = [];
  chain.forEach((element, position) => {
    let step = position + 1;
    if (typeof element === "object" && element !== null && !Array.isArray(element)) {
      const own = (element as { step?: unknown; index?: unknown }).step ?? (element as { index?: unknown }).index;
      if (typeof own === "number" && Number.isSafeInteger(own) && own >= 1) step = own;
    }
    const ids = factIdsIn(textOf(element));
    if (ids.length > 0) citations.push({ step, ids });
  });
  return citations;
}

/**
 * The requester's task data a submission carries to the verifier: the
 * `input` and `files` bindings the runtime rendered into the task (when it
 * had them), and the execution context the task runs in.
 */
export function factSubmitContextOf(task: AgentTask, execution?: AgentExecutionContext): FactSubmitContext {
  const input = task.input;
  const bindings =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as { bindings?: unknown }).bindings
      : undefined;
  const record =
    typeof bindings === "object" && bindings !== null && !Array.isArray(bindings)
      ? (bindings as Record<string, JsonValue>)
      : undefined;
  let review: FactReviewBinding | undefined;
  if (task.outputSchema?.name === "gameCommitteeDecision" && Array.isArray(record?.chain) &&
      typeof record.currentStep === "number" && record.currentStep === record.chain.length &&
      typeof record.comments === "object" && record.comments !== null && !Array.isArray(record.comments)) {
    const reports: Record<string, { reportHash: string; justification: string }> = {};
    for (const [id, raw] of Object.entries(record.comments)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const report = raw as { q?: unknown; justification?: unknown };
      if (typeof report.q !== "number" || !Number.isFinite(report.q) || report.q < 0 || report.q > 1 || typeof report.justification !== "string") continue;
      reports[id] = { reportHash: factReportHash({ q: report.q, justification: report.justification }), justification: report.justification };
    }
    const earlierChairTaskIds = earlierChairTaskIdsOf(task.metadata);
    review = { chairTaskId: task.taskId, reviewVersion: factReviewVersion(record.chain, record.currentStep), reports,
      ...(earlierChairTaskIds.length > 0 ? { earlierChairTaskIds } : {}) };
  }
  return {
    ...(record?.input !== undefined ? { input: record.input } : {}),
    ...(record?.files !== undefined ? { files: record.files } : {}),
    ...(execution !== undefined ? { execution } : {}),
    ...(execution?.signal !== undefined ? { signal: execution.signal } : {}),
    ...(review !== undefined ? { review } : {}),
  };
}

/** The earlier chair task ids of a round, as a re-assessment's metadata (`factReview`) carries them. */
function earlierChairTaskIdsOf(metadata: unknown): string[] {
  if (typeof metadata !== "object" || metadata === null) return [];
  const review = (metadata as { factReview?: unknown }).factReview;
  if (typeof review !== "object" || review === null || Array.isArray(review)) return [];
  const ids = (review as { earlierChairTaskIds?: unknown }).earlierChairTaskIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id !== "") : [];
}

/** What the run-global tool registration (Messages API path) knows about one executing task. */
export interface FactTaskBinding {
  readonly scope: FactScope;
  readonly context: FactSubmitContext;
}

/**
 * The fact scopes of the tasks currently executing, keyed by task id. A
 * run-global tool (the Messages path registers tools once per run) finds its
 * caller's scope and task data here; the worker's executor wrapper records a
 * task's binding before the task runs and clears it after.
 */
export class FactScopeRegistry {
  private readonly bindings = new Map<string, FactTaskBinding>();

  enter(taskId: string, binding: FactTaskBinding): void {
    this.bindings.set(taskId, binding);
  }

  leave(taskId: string): void {
    this.bindings.delete(taskId);
  }

  get(taskId: string | undefined): FactTaskBinding | undefined {
    return taskId === undefined ? undefined : this.bindings.get(taskId);
  }
}
