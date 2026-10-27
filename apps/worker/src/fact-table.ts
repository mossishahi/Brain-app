/**
 * The run's fact table: the justification badges the board's facts rest on.
 * core's facts.ts is the contract, and host-tools' fact_table tool parses
 * every request and words every answer; this is the worker's FactAccess —
 * one table per run, kept as an append-only log at
 * `<session>/<runId>/facts.jsonl` and shared by every task of the run.
 *
 * Lookups and status calls read the table as it stands. A submission is
 * ruled on by the supreme judge, which the wiring attaches as a FactVerifier
 * once the runtime exists (the verifier role's task, run through the run's
 * own executor). Everything around that call lives here: the per-task
 * submission budget, the exact-duplicate shortcut that needs no verification,
 * the related entries the judge is shown, the ceiling on one verification,
 * the checks a schema cannot make, and the commit — one ruling at a time,
 * verified once more when the table moved under it.
 *
 * The shared log holds entry snapshots and submission records:
 * - {"type":"entry"}: a full snapshot of one entry, written whenever the
 *   entry is created or changes; on load the last snapshot per id wins.
 * - {"type":"submission"}: one submission and what came of it, with its
 *   requester — the board's audit, never shown to an agent.
 * Every line is its own append, so a crash costs at most the line being
 * written: a resume ignores a partial last line and numbers new entries and
 * submissions after the highest ids on record. Reads and writes are
 * deadline-bounded like the run's other stores (see fs-stores.ts); a failed
 * write is announced and never fails the submission — its ruling stands for
 * the rest of this process, and only a later resume would miss it.
 *
 * With the control's fact updates (`updates: "delete-or-replace/v1"`), a ruling
 * that revokes an entry deletes it: the entry leaves the table, and the log
 * keeps one {"type":"deletion"} marker (id, sequence, time, replacement id)
 * in the ruling's own records, with no claim or reason. A refuted claim is
 * never entered. Earlier lines are never rewritten; a resume drops a deleted
 * id from the rebuilt table but still counts it, so it is never issued again.
 * Once a deletion is durable the table calls its update listener.
 *
 * Blind game critics use persisted private snapshots plus their own updates.
 * Their rulings are atomic transaction lines and writes must succeed before
 * a badge is exposed. Shared view-commit lines publish these updates for the
 * chair without changing other critics' snapshots; allocation lines reserve
 * unique identifiers across those private journals.
 *
 * Blindness: the supreme judge is shown the claim, its conditions, the
 * evidence and the related entries as any agent may see them, never who
 * asked; requesters live on the entries and in the log only.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { factVerdictSchema } from "@brainstorm-agentic/content";
import {
  addUsage,
  FACT_STATUSES,
  factBadgeHash,
  factDeletionAlert,
  factIdsIn,
  factStandingRevision,
  isFactId,
  type AgentExecutionContext,
  type FactAccess,
  type FactConsultQuery,
  type FactDeletion,
  type FactEvidenceSnapshot,
  type FactEntry,
  type FactEvent,
  type FactReviewBinding,
  type FactRequester,
  type FactScope,
  type FactStatus,
  type FactSubmission,
  type FactSubmissionOutcome,
  type FactSubmitContext,
  type FactTableLimits,
  type FactVerdict,
  type FactUpdateEvent,
  type FactUpdateListener,
  type FactUseApproval,
  type JsonObject,
  type JsonValue,
  type TokenUsage,
} from "@brainstorm-agentic/core";
import { factEntryView, formatFactOutcome, normalizeFactText, rankFacts } from "@brainstorm-agentic/host-tools";

import { DEFAULT_FS_DEADLINE_MS, readFileIfExists, withFsDeadline } from "./fs-stores.js";
import { consultSnapshot, publicFactBadge, supremeFactView, type FactConsultant } from "./fact-consultation.js";

/** One verification the table asks of the supreme judge. */
export interface FactVerificationRequest {
  /** The submission under verification, "S:n". */
  readonly submission: string;
  /**
   * The supreme judge's prompt bindings: the requester's `input` and `files`
   * (the submission the board works on, and the file map attachments are
   * read through), the request — claim, conditions, evidence, kind, step,
   * purpose — and the related entries as agents see them. None of it names
   * the requester.
   */
  readonly bindings: {
    readonly input: JsonValue;
    readonly files: JsonValue;
    readonly request: JsonObject;
    readonly related: JsonValue;
  };
  /** The requester's execution context (run id, node path), when it came with one. */
  readonly execution?: AgentExecutionContext;
  /** The requester's signal, combined with the ceiling on one verification. */
  readonly signal: AbortSignal;
}

/** The supreme judge's ruling on one submission. */
export interface FactVerification {
  readonly verdict: FactVerdict;
  /** The verifier task's id, recorded with the submission. */
  readonly taskId: string;
  readonly usage?: TokenUsage;
}

/** Runs the supreme judge on one submission; the wiring attaches it. */
export type FactVerifier = (request: FactVerificationRequest) => Promise<FactVerification>;

export interface FileFactTableOptions {
  readonly accessMode?: "supreme-mediated/v1";
  /** The run's log, `<session>/<runId>/facts.jsonl`; the first write creates it. */
  readonly logPath: string;
  /** The control's budgets (catalog/fact-table.json `limits`). */
  readonly limits: FactTableLimits;
  /** Test seam: the clock entries and events are stamped with. */
  readonly now?: () => number;
  /** Private blind-review journals must persist before exposing a badge. */
  readonly strictWrites?: boolean;
  /** Exclusive id ranges are reserved in the parent journal before a private view starts. */
  readonly allocation?: { readonly factThrough: number; readonly submissionThrough: number };
  /**
   * The control's fact updates (catalog/fact-table.json `updates`): a revoked
   * entry is deleted and replaced by the ruling's new badge, and a refuted
   * claim is never entered. Absent: today's revoked and refuted entries.
   */
  readonly updates?: "delete-or-replace/v1";
}

const NO_VERIFIER = "The fact table's verifier is not available in this run.";
const UNSHOWN_ENTRIES = "The ruling referenced entries the supreme judge was not shown.";
/** The history event of a shared entry a private review revoked (decision D3). */
const PRIVATE_REVOCATION = "Revoked in a private review; pending a ruling against the shared table's combined evidence.";
/** A mediated status call whose requested ids are all deleted or unknown makes no consultation. */
const NO_LIVE_BADGE = "None of the requested badges is in the fact table: see deleted and unknown.";

/**
 * A deletion as a log stores it. In a private journal, `shared` marks a copy
 * of a deletion the shared table had made when the view was seeded: it is
 * answered like the view's own, but it is neither the view's deletion to
 * publish nor one of its ids to count.
 */
interface StoredDeletion extends FactDeletion {
  readonly shared?: boolean;
}

/** Why a deleted id was deleted, from the submission line whose ruling deleted it. */
interface DeletionReason {
  readonly reason: string;
  readonly submission: string;
}

/** Consultation usage spent on scans whose table moved before they could commit (decision D15). */
interface SpentConsultation {
  readonly taskIds: readonly string[];
  readonly usage?: TokenUsage;
}

function withSpent<T extends { readonly taskIds: readonly string[]; readonly usage?: TokenUsage }>(result: T, spent: SpentConsultation): T {
  if (spent.taskIds.length === 0 && spent.usage === undefined) return result;
  const usage = spent.usage !== undefined && result.usage !== undefined
    ? addUsage(spent.usage, result.usage)
    : (result.usage ?? spent.usage);
  return { ...result, taskIds: [...spent.taskIds, ...result.taskIds], ...(usage !== undefined ? { usage } : {}) };
}

const FACT_NUMBER = /^F:([1-9][0-9]*)$/;
const SUBMISSION_NUMBER = /^S:([1-9][0-9]*)$/;

/** The number in an "F:n" or "S:n" id; 0 for anything else. */
function numberOf(id: unknown, pattern: RegExp): number {
  const match = typeof id === "string" ? pattern.exec(id) : null;
  return match ? Number(match[1]) : 0;
}

function byNumber(a: FactEntry, b: FactEntry): number {
  return numberOf(a.id, FACT_NUMBER) - numberOf(b.id, FACT_NUMBER);
}

function factEvent(at: number, event: FactEvent["event"], by: string, detail?: string): FactEvent {
  return { at, event, by, ...(detail !== undefined ? { detail } : {}) };
}

function sameRequester(a: FactRequester, b: FactRequester): boolean {
  return (
    a.taskId === b.taskId &&
    a.role === b.role &&
    a.agent === b.agent &&
    a.seat === b.seat &&
    a.step === b.step
  );
}

function minutes(count: number): string {
  return `${count} minute${count === 1 ? "" : "s"}`;
}

/** A snapshot as this table wrote it; only the anchors of its shape are checked. */
function isStoredEntry(value: unknown): value is FactEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { id, status, history, requesters } = value as {
    id?: unknown;
    status?: unknown;
    history?: unknown;
    requesters?: unknown;
  };
  return (
    isFactId(id) &&
    (FACT_STATUSES as readonly unknown[]).includes(status) &&
    Array.isArray(history) &&
    Array.isArray(requesters)
  );
}

interface FactLog {
  readonly entries: readonly FactEntry[];
  readonly highestFact: number;
  readonly highestSubmission: number;
  /** The file ends inside a line: the next append starts a fresh one. */
  readonly openLine: boolean;
  readonly publishedViews: ReadonlyMap<string, readonly FactEntry[]>;
  /** Deletion markers by id. */
  readonly deletions: ReadonlyMap<string, StoredDeletion>;
  /** The last snapshot of each deleted id before its deletion; in memory only, never returned by a call. */
  readonly lastStanding: ReadonlyMap<string, FactEntry>;
  /** The ruling's explanation of each deleted id, from the submission line that deleted it. */
  readonly deletionReasons: ReadonlyMap<string, DeletionReason>;
}

/** Only newline-terminated records are committed, including an entire private transaction. */
function committedRecords(text: string): object[] {
  const lines = text.split("\n");
  lines.pop();
  const records: object[] = [];
  for (const line of lines) {
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
      const transaction = record as { type?: unknown; records?: unknown };
      if (transaction.type === "transaction") {
        if (Array.isArray(transaction.records) && transaction.records.every(
          (item) => typeof item === "object" && item !== null && !Array.isArray(item),
        )) records.push(...transaction.records);
      } else records.push(record);
    } catch { /* A crash may leave a partial line before a later append. */ }
  }
  return records;
}

/**
 * Rebuilds the table from its log. Every id the log mentions counts toward
 * the numbering — an event's cause, a successor, a submission's badge — so a
 * resume never hands out an id an earlier line already refers to. A deletion
 * marker removes its id from the rebuilt entries for good: a later snapshot of
 * a deleted id is ignored, and the id and its replacement still count.
 */
function parseFactLog(text: string): FactLog {
  const lines = text.split("\n");
  // Whatever follows the last newline is a line a crash cut short, or nothing.
  const tail = lines.pop() ?? "";
  const entries = new Map<string, FactEntry>();
  const publishedViews = new Map<string, readonly FactEntry[]>();
  const deletions = new Map<string, StoredDeletion>();
  const lastStanding = new Map<string, FactEntry>();
  const deletionReasons = new Map<string, DeletionReason>();
  let highestFact = 0;
  let highestSubmission = 0;
  const saw = (id: unknown): void => {
    highestFact = Math.max(highestFact, numberOf(id, FACT_NUMBER));
    highestSubmission = Math.max(highestSubmission, numberOf(id, SUBMISSION_NUMBER));
  };
  for (const record of committedRecords(text)) {
    const { type, entry, id, badge, recorded, conflicts, factThrough, submissionThrough, view, entries: committedEntries, seq, at, replacedBy, shared, verdict } = record as {
      type?: unknown;
      entry?: unknown;
      id?: unknown;
      badge?: unknown;
      recorded?: unknown;
      conflicts?: unknown;
      factThrough?: unknown;
      submissionThrough?: unknown;
      entries?: unknown;
      view?: { key?: unknown; entries?: unknown };
      seq?: unknown;
      at?: unknown;
      replacedBy?: unknown;
      shared?: unknown;
      verdict?: { conflicts?: unknown };
    };
    if (type === "entry" && isStoredEntry(entry)) {
      if (!deletions.has(entry.id)) entries.set(entry.id, entry);
      saw(entry.id);
      saw(entry.supersededBy);
      for (const event of entry.history) saw((event as { by?: unknown } | null)?.by);
    } else if (type === "deletion" && isFactId(id) && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 1 &&
        typeof at === "number" && Number.isFinite(at)) {
      const before = entries.get(id);
      if (before !== undefined) lastStanding.set(id, before);
      entries.delete(id);
      deletions.set(id, { id, seq, at, ...(isFactId(replacedBy) ? { replacedBy } : {}), ...(shared === true ? { shared: true } : {}) });
      // A private view's copy of a shared deletion names the shared table's ids,
      // which are outside the view's own allocation.
      if (shared !== true) {
        saw(id);
        saw(replacedBy);
      }
    } else if (type === "allocation") {
      if (typeof factThrough === "number" && Number.isSafeInteger(factThrough) && factThrough >= 0) {
        highestFact = Math.max(highestFact, factThrough);
      }
      if (typeof submissionThrough === "number" && Number.isSafeInteger(submissionThrough) && submissionThrough >= 0) {
        highestSubmission = Math.max(highestSubmission, submissionThrough);
      }
    } else if (type === "view-commit" && Array.isArray(committedEntries) && committedEntries.every(isStoredEntry)) {
      for (const changed of committedEntries) {
        if (!deletions.has(changed.id)) entries.set(changed.id, changed);
        saw(changed.id);
      }
      if (typeof view?.key === "string" && Array.isArray(view.entries) && view.entries.every(isStoredEntry)) {
        publishedViews.set(view.key, view.entries);
      }
    } else if (type === "submission") {
      saw(id);
      saw(badge);
      saw(recorded);
      if (Array.isArray(conflicts)) {
        for (const conflict of conflicts) {
          const { id: conflictId, resolution } = (conflict ?? {}) as { id?: unknown; resolution?: unknown };
          saw(conflictId);
          // The ruling that deleted an entry: its explanation is the notice's reason.
          if (resolution === "incumbent-revoked" && typeof conflictId === "string" && deletions.has(conflictId) &&
              !deletionReasons.has(conflictId) && typeof id === "string") {
            const rulings: unknown[] = Array.isArray(verdict?.conflicts) ? (verdict!.conflicts as unknown[]) : [];
            const ruling = rulings.find((item) => (item as { id?: unknown } | null)?.id === conflictId) as { explanation?: unknown } | undefined;
            deletionReasons.set(conflictId, { reason: typeof ruling?.explanation === "string" ? ruling.explanation : "", submission: id });
          }
        }
      }
    }
  }
  return { entries: [...entries.values()], highestFact, highestSubmission, openLine: tail !== "", publishedViews,
    deletions, lastStanding, deletionReasons };
}

function factStanding(entry: FactEntry): string {
  return JSON.stringify([entry.status, entry.claim, entry.conditions, entry.method, entry.evidence, entry.supersededBy]);
}

function uniqueRecords<T>(records: readonly T[]): T[] {
  return [...new Map(records.map((record) => [JSON.stringify(record), record])).values()];
}

async function atomicFactFile(path: string, text: string): Promise<void> {
  await withFsDeadline(mkdir(dirname(path), { recursive: true }), DEFAULT_FS_DEADLINE_MS, `creating ${dirname(path)}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await withFsDeadline(writeFile(temporary, text, "utf8"), DEFAULT_FS_DEADLINE_MS, `writing ${path}`);
  await withFsDeadline(rename(temporary, path), DEFAULT_FS_DEADLINE_MS, `publishing ${path}`);
}

/** Why a verification failed, in one line the requester can read. */
function failureText(error: unknown): string {
  const issues = (error as { readonly issues?: unknown } | null | undefined)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    // A schema rejection: its first issues, not the whole dump.
    const named = issues.slice(0, 3).map((issue) => {
      const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown };
      const where = Array.isArray(path) && path.length > 0 ? path.join(".") : "verdict";
      return `${where}: ${typeof message === "string" ? message : "invalid"}`;
    });
    return `its verdict failed validation (${named.join("; ")}${issues.length > 3 ? "; …" : ""})`;
  }
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  if (text === "") return "it failed without saying why";
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

/**
 * `work`'s own settlement, or the signal's reason the moment it aborts — so
 * the ceiling holds even against a verifier that ignores its signal. Work
 * that loses the race is left to finish unobserved.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * One run of the supreme judge: a ruling that passed every check, or why
 * there is none (the claim then stays unverified). `version` is the table
 * version the judge was shown.
 */
type Attempt =
  | {
      readonly version: number;
      readonly verdict: FactVerdict;
      readonly taskId: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly version: number;
      readonly refusal: string;
      readonly taskId?: string;
      readonly usage?: TokenUsage;
    };

/** What a committed ruling's new entries are made of. */
interface Ruled {
  readonly at: number;
  readonly id: string;
  readonly requester: FactRequester;
  readonly submission: FactSubmission;
  readonly verdict: FactVerdict;
}

/** One change to an entry: the event that records it, and what it changes beyond the history. */
interface Revision {
  readonly event: FactEvent;
  readonly status?: FactStatus;
  readonly conditions?: string;
  readonly supersededBy?: string;
  /** The requester that obtained the entry. */
  readonly requester?: FactRequester;
}

export class FileFactTable implements FactAccess {
  readonly accessMode: "supreme-mediated/v1" | undefined;
  private readonly logPath: string;
  private readonly limits: FactTableLimits;
  private readonly now: () => number;
  private readonly strictWrites: boolean;
  private readonly allocation: FileFactTableOptions["allocation"];
  private readonly updates: FileFactTableOptions["updates"];
  /** Deletions (control `updates`) by id; see StoredDeletion for a private view's shared copies. */
  private readonly deletionsById = new Map<string, StoredDeletion>();
  /** The last standing of each deleted id: only to compose a notice a crash kept from its journal. */
  private readonly lastStanding = new Map<string, FactEntry>();
  private readonly deletionReasons = new Map<string, DeletionReason>();
  private readonly updateListeners: FactUpdateListener[] = [];
  private readonly views = new Map<string, Promise<FactAccess>>();
  private readonly publishedViews = new Map<string, readonly FactEntry[]>();
  private verifier: FactVerifier | undefined;
  private consultant: FactConsultant | undefined;
  private readonly approvals = new Map<string, FactUseApproval>();
  private readonly aliases = new Map<string, JsonObject>();
  private readonly unbudgetedSubmissions = new Set<string>();
  /**
   * The entries as they stand, by id. Every change a ruling makes happens in
   * one synchronous step, so any read is a consistent snapshot.
   */
  private readonly byId = new Map<string, FactEntry>();
  private nextFact = 1;
  private nextSubmission = 1;
  /** Private views restore their task budget on resume; the legacy shared table starts fresh. */
  private readonly submitted = new Map<string, number>();
  /**
   * The table's version, bumped by every change a ruling may rest on — an
   * entry created, or its status, conditions or successor changed — and the
   * version each entry last changed at. A "relied" or "upheld" event leaves
   * every standing as it was, so it never sends a ruling back.
   */
  private version = 0;
  private readonly changedAt = new Map<string, number>();
  /** The commit mutex: one ruling commits at a time (serialized like FsArtifactStore's puts). */
  private commits: Promise<unknown> = Promise.resolve();
  /** Appends, in the order the table changed. */
  private writes: Promise<void> = Promise.resolve();
  private openLine = false;
  private directoryReady = false;
  private writeFailing = false;
  /** A failed strict append invalidates the in-memory view until it is reopened from disk. */
  private persistenceError: unknown;
  /** The resume: an existing log, read once before any call is answered. */
  private readonly loaded: Promise<void>;

  constructor(options: FileFactTableOptions) {
    this.logPath = options.logPath;
    this.limits = options.limits;
    this.now = options.now ?? Date.now;
    this.accessMode = options.accessMode;
    this.strictWrites = options.accessMode === "supreme-mediated/v1" || (options.strictWrites ?? false);
    this.allocation = options.allocation;
    this.updates = options.updates;
    this.loaded = this.load();
    // Every call awaits the load; this only keeps a failed one from also
    // surfacing as an unhandled rejection before the first call arrives.
    this.loaded.catch(() => undefined);
  }

  /** The supreme judge; the wiring attaches it once the runtime exists. */
  attachVerifier(verifier: FactVerifier): void {
    this.verifier = verifier;
  }

  attachConsultant(consultant: FactConsultant): void {
    this.consultant = consultant;
  }

  /**
   * Called once per deletion from this table, after the ruling's records are
   * durable (never after a failed write). The spawner of fact-update
   * reconsiderations listens here; a private view has no listener.
   */
  onUpdate(listener: FactUpdateListener): void {
    this.updateListeners.push(listener);
  }

  /** The deletion epoch: how many deletions this table's own log records. */
  async deletionEpoch(): Promise<number> {
    await this.loaded;
    return this.ownDeletions().length;
  }

  async deletions(signal?: AbortSignal): Promise<readonly FactDeletion[]> {
    await (signal !== undefined ? abortable(this.loaded, signal) : this.loaded);
    if (this.persistenceError !== undefined) throw this.persistenceError;
    return this.deletionList();
  }

  /**
   * Every deletion of this table with what its notice needs, in deletion
   * order: the entry as it last stood, the ruling's explanation and the
   * replacement. For the spawner only, to compose a notice that a crash
   * between a deletion and its notice kept from its journal (design 6.7).
   */
  async updateEvents(): Promise<readonly FactUpdateEvent[]> {
    await this.loaded;
    return this.ownDeletions().flatMap((deletion): FactUpdateEvent[] => {
      const entry = this.lastStanding.get(deletion.id);
      if (entry === undefined) return [];
      const why = this.deletionReasons.get(deletion.id);
      const replacement = deletion.replacedBy !== undefined
        ? this.byId.get(deletion.replacedBy) ?? this.lastStanding.get(deletion.replacedBy)
        : undefined;
      return [{ deletion: this.publicDeletion(deletion), entry, reason: why?.reason ?? "",
        ...(replacement !== undefined ? { replacement } : {}), submission: why?.submission ?? "" }];
    });
  }

  private publicDeletion(deletion: StoredDeletion): FactDeletion {
    return { id: deletion.id, seq: deletion.seq, at: deletion.at,
      ...(deletion.replacedBy !== undefined ? { replacedBy: deletion.replacedBy } : {}) };
  }

  /** Every deletion, a private view's shared copies first, in deletion order. */
  private deletionList(): FactDeletion[] {
    return [...this.deletionsById.values()]
      .sort((a, b) => Number(b.shared === true) - Number(a.shared === true) || a.seq - b.seq)
      .map((deletion) => this.publicDeletion(deletion));
  }

  /** The deletions this table's own rulings made (a private view's shared copies excluded). */
  private ownDeletions(): StoredDeletion[] {
    return [...this.deletionsById.values()].filter((deletion) => deletion.shared !== true).sort((a, b) => a.seq - b.seq);
  }

  async evidence(): Promise<FactEvidenceSnapshot> {
    await this.loaded;
    return this.locked(async () => ({ facts: this.list(), approvals: [...this.approvals.values()],
      ...(this.updates !== undefined ? { deletions: this.deletionList() } : {}) }));
  }

  private consultationSignal(context: FactSubmitContext): AbortSignal {
    const ceiling = AbortSignal.timeout(Math.max(1, Math.round(this.limits.verificationMinutes * 60_000)));
    return context.signal === undefined ? ceiling : AbortSignal.any([context.signal, ceiling]);
  }

  /** The only public query path for new bundles; raw snapshots go to Supreme tasks only. */
  async consult(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext): Promise<JsonObject> {
    if (this.accessMode !== "supreme-mediated/v1") throw new Error("This table uses the legacy fact interface.");
    await this.entries(context.signal);
    const signal = this.consultationSignal(context);
    const boundedContext = { ...context, signal };
    if (query.mode === "submit") {
      if (!query.claim || query.conditions === undefined || !query.evidence || !query.kind) {
        throw new Error("A submission needs a claim, conditions, evidence and kind.");
      }
      const outcome = await this.submit(requester, {
        claim: query.claim, conditions: query.conditions, evidence: query.evidence, kind: query.kind,
        ...(query.step !== undefined ? { step: query.step } : {}),
        ...(query.purpose !== undefined ? { purpose: query.purpose } : {}),
      }, boundedContext);
      return { ...formatFactOutcome(outcome),
        ...(outcome.badge !== undefined ? { badge: publicFactBadge(outcome.badge) } : {}),
        ...(outcome.recorded !== undefined ? { recorded: publicFactBadge(outcome.recorded) } : {}),
        ...(outcome.conflicts.length > 0 ? { conflicts: outcome.conflicts.map((conflict) => ({
          resolution: conflict.resolution, explanation: conflict.explanation, entry: publicFactBadge(conflict.entry),
          ...(conflict.deleted === true ? { deleted: true } : {}),
        })) } : {}) };
    }
    if (query.mode === "approve") return this.approve(requester, query, boundedContext);
    const request = JSON.parse(JSON.stringify(query)) as JsonObject;
    // With fact updates, every consultation is recorded with its usage
    // (decision D15): a scan whose table moved before it could commit adds its
    // tasks and usage to the line of the scan that does.
    let spent: SpentConsultation = { taskIds: [] };
    for (;;) {
      signal.throwIfAborted();
      const version = this.version;
      const snapshot = this.list();
      // Explicit status IDs are addressed directly, but Supreme still interprets the answer.
      const selected = query.mode === "status"
        ? snapshot.filter((entry) => query.ids?.includes(entry.id)) : snapshot;
      // A deleted id is answered by the host itself: deleted, with its
      // replacement and alert. No consultation is made when no requested id
      // stands in the table.
      const deleted = query.mode === "status" && this.updates !== undefined ? this.deletedAnswers(query.ids ?? []) : [];
      const deletedIds = new Set(deleted.map((item) => item.id as string));
      if (query.mode === "status" && this.updates !== undefined && (query.ids ?? []).length > 0 && selected.length === 0) {
        return { mode: query.mode, answer: NO_LIVE_BADGE, matches: [], entries: [],
          unknown: (query.ids ?? []).filter((id) => !deletedIds.has(id)),
          ...(deleted.length > 0 ? { deleted } : {}) };
      }
      const result = await this.semanticScan(selected, request, boundedContext);
      const committed = await this.locked(async () => {
        if (this.version !== version) return false;
        await this.recordConsultation(requester, request, withSpent(result, spent), snapshot);
        return true;
      });
      if (!committed) {
        if (this.updates !== undefined) spent = withSpent(result, spent);
        continue;
      }
      const found = new Map(selected.map((entry) => [entry.id, entry]));
      const matches = query.mode === "lookup"
        ? result.matches.slice(0, query.max_results ?? this.limits.lookupResults) : result.matches;
      return { mode: query.mode, answer: result.answer,
        matches: matches.map((match) => ({ ...match, badge: publicFactBadge(found.get(match.factId)!) })),
        ...(query.mode === "lookup" ? { totalMatches: result.matches.length } : {}),
        ...(query.mode === "status" ? { entries: selected.map(publicFactBadge),
          unknown: (query.ids ?? []).filter((id) => !found.has(id) && !deletedIds.has(id)),
          ...(deleted.length > 0 ? { deleted } : {}) } : {}) };
    }
  }

  /** The requested ids this table deleted, as a mediated status answer lists them. */
  private deletedAnswers(ids: readonly string[]): JsonObject[] {
    return [...new Set(ids)].flatMap((id) => {
      const deletion = this.byId.has(id) ? undefined : this.deletionsById.get(id);
      return deletion === undefined ? [] : [{ id, ...(deletion.replacedBy !== undefined ? { replacedBy: deletion.replacedBy } : {}),
        alert: factDeletionAlert(deletion) }];
    });
  }

  private async semanticScan(entries: readonly FactEntry[], request: JsonObject, context: FactSubmitContext) {
    if (this.consultant === undefined) throw new Error("The supreme consultation service is unavailable.");
    const certifiedAliases = [...this.aliases.values()].filter((alias) => {
      const entry = entries.find((candidate) => candidate.id === alias.targetId);
      return alias.claim === (request.claim ?? "") && alias.conditions === (request.conditions ?? "") && alias.kind === (request.kind ?? "") &&
        entry !== undefined && alias.badgeHash === factBadgeHash(entry) && alias.standingRevision === factStandingRevision(entry);
    });
    return consultSnapshot({ entries, request: { ...request, phase: "match", certifiedAliases }, context,
      batchSize: this.limits.relatedFacts, consultant: this.consultant,
      signal: context.signal ?? this.consultationSignal(context) });
  }

  private async recordConsultation(requester: FactRequester, request: JsonObject,
    result: Awaited<ReturnType<typeof consultSnapshot>>, entries: readonly FactEntry[]): Promise<void> {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const aliases = result.matches.filter((match) => match.relation === "equivalent").map((match) => {
      const entry = byId.get(match.factId)!;
      const value: JsonObject = { claim: request.claim ?? "", conditions: request.conditions ?? "", kind: request.kind ?? "",
        targetId: entry.id, badgeHash: factBadgeHash(entry), standingRevision: factStandingRevision(entry), reason: match.reason };
      return { id: createHash("sha256").update(JSON.stringify(value)).digest("hex"), value };
    });
    await this.append([{ type: "consultation", at: this.now(), requester, request,
      answer: result.answer, matches: result.matches, taskIds: result.taskIds,
      ...(result.usage !== undefined ? { usage: result.usage } : {}) },
      ...aliases.map((alias) => ({ type: "semantic-alias", ...alias }))], true);
    for (const alias of aliases) this.aliases.set(alias.id, alias.value);
  }

  private async approve(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext): Promise<JsonObject> {
    const review = context.review;
    const report = query.criticId !== undefined ? review?.reports[query.criticId] : undefined;
    if (!review || review.chairTaskId !== requester.taskId || requester.role !== "committee-chair" || !report ||
      !query.factId || !query.badgeHash || !factIdsIn(report.justification).includes(query.factId)) {
      throw new Error("Fact approval requires the actual committee task, reviewed report and its cited badge.");
    }
    const signal = context.signal!;
    let spent: SpentConsultation = { taskIds: [] };
    for (;;) {
      signal.throwIfAborted();
      const deletion = this.byId.has(query.factId) ? undefined : this.deletionsById.get(query.factId);
      if (deletion !== undefined) {
        throw new Error(deletion.replacedBy !== undefined
          ? `The cited badge ${query.factId} was deleted from the fact table and replaced by ${deletion.replacedBy}; it cannot support a report.`
          : `The cited badge ${query.factId} was deleted from the fact table; it cannot support a report.`);
      }
      // A re-assessment of the round (decisions D4, D12): an earlier chair task's
      // approval of the unchanged report and badge is returned again, without a
      // consultation, while the cited badge and the approved target stand as
      // they stood.
      const reused = this.updates !== undefined ? this.reusableApproval(review, query, report.reportHash) : undefined;
      if (reused !== undefined) {
        return { mode: "approve", answer: reused.receipt.reason, approval: { ...reused.receipt },
          ...(reused.target !== undefined ? { badge: publicFactBadge(reused.target) } : {}) };
      }
      const cited = this.byId.get(query.factId);
      if (!cited || factBadgeHash(cited) !== query.badgeHash || cited.status === "revoked" || cited.status === "refuted") {
        throw new Error("The cited badge is unknown, revoked, refuted, or its content hash is stale.");
      }
      let target = cited;
      if (cited.status === "disputed") {
        // This is a committee approval's internal reconciliation, not a critic submission.
        const outcome = await this.submitChecked(requester, {
          claim: cited.claim, conditions: cited.conditions, evidence: cited.evidence, kind: cited.kind,
          purpose: "Reconcile a private badge against all shared evidence before approving its use.",
        }, context, false);
        if (outcome.badge === undefined || outcome.badge.status !== "justified") {
          return this.recordApproval(requester, query, context, cited, undefined, false,
            outcome.refusal ?? outcome.verdict?.explanation ?? "The shared evidence remains unresolved.");
        }
        target = outcome.badge;
      }
      const version = this.version;
      if (this.consultant === undefined) throw new Error("The supreme consultation service is unavailable.");
      const entries = cited.id === target.id ? [target] : [cited, target];
      const { criticId: _criticId, ...anonymousQuery } = query;
      const result = await consultSnapshot({ entries,
        request: { ...JSON.parse(JSON.stringify(anonymousQuery)) as JsonObject, phase: "approve",
          justification: report.justification, proposedTargetFactId: target.id }, context,
        batchSize: entries.length, consultant: this.consultant, signal });
      if (result.approval === undefined) throw new Error("The supreme judge supplied no approval decision.");
      const approval = result.approval;
      if (approval.approved && approval.targetFactId !== target.id) {
        throw new Error("The supreme approval did not name the proposed justified badge.");
      }
      const receipt = await this.locked(async () => {
        if (this.version !== version) return undefined;
        const currentCited = this.byId.get(cited.id);
        const currentTarget = this.byId.get(target.id);
        if (!currentCited || factBadgeHash(currentCited) !== query.badgeHash ||
          currentCited.status === "revoked" || currentCited.status === "refuted" ||
          !currentTarget || currentTarget.status !== "justified" || factBadgeHash(currentTarget) !== factBadgeHash(target)) {
          throw new Error("The badge changed before its approval could be committed.");
        }
        await this.recordConsultation(requester, { mode: "approve", phase: "approve", factId: cited.id }, withSpent(result, spent), entries);
        return this.recordApproval(requester, query, context, currentCited, currentTarget, approval.approved, approval.reason);
      });
      if (receipt !== undefined) return receipt;
      if (this.updates !== undefined) spent = withSpent(result, spent);
    }
  }

  /**
   * The receipt an earlier chair task of the same round obtained for this
   * report and cited badge, when it may be returned again: same reviewed
   * version, critic, report hash, cited id and hash; the cited badge still
   * stands with that hash; and an approved target is still justified with the
   * receipt's hash and standing. The latest such receipt wins.
   */
  private reusableApproval(review: FactReviewBinding, query: FactConsultQuery, reportHash: string):
    { readonly receipt: FactUseApproval; readonly target?: FactEntry } | undefined {
    const earlier = new Set(review.earlierChairTaskIds ?? []);
    if (earlier.size === 0 || query.factId === undefined) return undefined;
    const cited = this.byId.get(query.factId);
    if (!cited || factBadgeHash(cited) !== query.badgeHash || cited.status === "revoked" || cited.status === "refuted") return undefined;
    let found: { readonly receipt: FactUseApproval; readonly target?: FactEntry } | undefined;
    for (const receipt of this.approvals.values()) {
      if (!earlier.has(receipt.requesterTaskId) || receipt.reviewVersion !== review.reviewVersion ||
          receipt.criticId !== query.criticId || receipt.reportHash !== reportHash ||
          receipt.citedBadgeId !== cited.id || receipt.citedBadgeHash !== query.badgeHash) continue;
      if (receipt.targetBadgeId === "") {
        found = { receipt };
        continue;
      }
      const target = this.byId.get(receipt.targetBadgeId);
      if (!target || target.status !== "justified" || factBadgeHash(target) !== receipt.targetBadgeHash ||
          factStandingRevision(target) !== receipt.targetStandingRevision) continue;
      found = { receipt, target };
    }
    return found;
  }

  private async recordApproval(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext,
    cited: FactEntry, target: FactEntry | undefined, approved: boolean, reason: string): Promise<JsonObject> {
    const review = context.review!;
    const receipt: FactUseApproval = {
      id: `A:${randomUUID()}`, requesterTaskId: requester.taskId, reviewVersion: review.reviewVersion,
      reportHash: review.reports[query.criticId!]!.reportHash, criticId: query.criticId!,
      citedBadgeId: cited.id, citedBadgeHash: query.badgeHash!, targetBadgeId: target?.id ?? "",
      targetBadgeHash: target === undefined ? "" : factBadgeHash(target),
      targetStandingRevision: target === undefined ? "" : factStandingRevision(target), approved, reason,
    };
    await this.append([{ type: "approval", at: this.now(), approval: receipt }], true);
    this.approvals.set(receipt.id, receipt);
    return { mode: "approve", answer: reason, approval: { ...receipt },
      ...(target !== undefined ? { badge: publicFactBadge(target) } : {}) };
  }

  async entries(signal?: AbortSignal): Promise<readonly FactEntry[]> {
    await (signal !== undefined ? abortable(this.loaded, signal) : this.loaded);
    if (this.persistenceError !== undefined) throw this.persistenceError;
    return this.list();
  }

  /**
   * Each parallel critic sees the same persisted initial table and its own
   * verified changes. A private journal also isolates verifier context and
   * duplicate lookup, so submit cannot disclose a peer's new facts.
   */
  async forTask(taskId: string, scope: FactScope): Promise<FactAccess> {
    if (scope.blindReview === undefined) return this;
    await this.loaded;
    if (this.persistenceError !== undefined) throw this.persistenceError;
    const group = scope.blindReview;
    const key = JSON.stringify([group, taskId]);
    let pending = this.views.get(key);
    if (pending === undefined) {
      pending = this.locked(() => this.openView(key, group, taskId));
      this.views.set(key, pending);
      pending.catch(() => this.views.delete(key));
    }
    return pending;
  }

  private async openView(key: string, group: string, taskId: string): Promise<FactAccess> {
    const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
    const directory = join(dirname(this.logPath), "fact-views", hash(group));
    const snapshotPath = join(directory, "snapshot.json");
    const savedSnapshot = await readFileIfExists(snapshotPath, DEFAULT_FS_DEADLINE_MS);
    if (savedSnapshot === undefined) {
      const existing = await withFsDeadline(readdir(directory), DEFAULT_FS_DEADLINE_MS, `reading ${directory}`)
        .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      const published = [...this.publishedViews.keys()].some((savedKey) => {
        try { return (JSON.parse(savedKey) as unknown[])[0] === group; } catch { return false; }
      });
      if (existing.length > 0 || published) {
        throw new Error("The existing blind review snapshot is missing; refusing to expose live peer facts.");
      }
    }
    const snapshot: unknown = savedSnapshot === undefined ? this.list() : JSON.parse(savedSnapshot);
    if (!Array.isArray(snapshot) || !snapshot.every(isStoredEntry)) {
      throw new Error("The blind review fact snapshot is invalid; refusing to replace it with live peer facts.");
    }
    if (savedSnapshot === undefined) await atomicFactFile(snapshotPath, JSON.stringify(snapshot));

    const descriptorPath = join(directory, `${hash(taskId)}.json`);
    const logPath = join(directory, `${hash(taskId)}.jsonl`);
    const savedDescriptor = await readFileIfExists(descriptorPath, DEFAULT_FS_DEADLINE_MS);
    const savedJournal = await readFileIfExists(logPath, DEFAULT_FS_DEADLINE_MS);
    if (savedDescriptor === undefined && (savedJournal !== undefined || this.publishedViews.has(key))) {
      throw new Error("An existing private fact view is missing its id allocation.");
    }
    if (savedJournal === undefined && this.publishedViews.has(key)) {
      throw new Error("An existing private fact journal is missing; refusing to reset its facts or budget.");
    }
    let allocation: { factFrom: number; factThrough: number; submissionFrom: number; submissionThrough: number; initialized?: boolean };
    if (savedDescriptor === undefined) {
      const size = Math.max(32, this.limits.submissionsPerTask * 4);
      allocation = {
        factFrom: this.nextFact,
        factThrough: this.nextFact + size - 1,
        submissionFrom: this.nextSubmission,
        submissionThrough: this.nextSubmission + size - 1,
      };
      this.nextFact += size;
      this.nextSubmission += size;
      await this.append([{ type: "allocation", ...allocation }], true);
      await atomicFactFile(descriptorPath, JSON.stringify(allocation));
    } else {
      allocation = JSON.parse(savedDescriptor) as typeof allocation;
      if (!allocation || ![allocation.factFrom, allocation.factThrough, allocation.submissionFrom, allocation.submissionThrough]
        .every((value) => Number.isSafeInteger(value) && value >= 1)
        || allocation.factFrom > allocation.factThrough || allocation.submissionFrom > allocation.submissionThrough) {
        throw new Error("Invalid private fact id allocation.");
      }
    }
    if (savedJournal === undefined && allocation.initialized === true) {
      throw new Error("An initialized private fact journal is missing; refusing to reset its submission budget.");
    }
    if (savedJournal === undefined) {
      // With fact updates, the frozen snapshot minus every id the shared table
      // has deleted by now (the snapshot file itself is never rewritten), plus
      // copies of those deletions, so the view answers a deleted id as deleted.
      const shared = this.updates !== undefined ? this.deletionList() : [];
      const deletedNow = new Set(shared.map((deletion) => deletion.id));
      const seed = [
        ...snapshot.filter((entry) => !deletedNow.has(entry.id)).map((entry) => ({ type: "entry", entry })),
        ...shared.map((deletion) => ({ type: "deletion", ...deletion, shared: true })),
        { type: "allocation", factThrough: allocation.factFrom - 1, submissionThrough: allocation.submissionFrom - 1 },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n";
      await atomicFactFile(logPath, seed);
    }
    // Mark readiness before returning any view. A missing initialized journal
    // must not be confused with a crash during its first creation, even when
    // every submitted claim was unverified and published no new facts.
    if (allocation.initialized !== true) {
      allocation = { ...allocation, initialized: true };
      await atomicFactFile(descriptorPath, JSON.stringify(allocation));
    }
    const child = new FileFactTable({ logPath, limits: this.limits, now: this.now, allocation, strictWrites: true,
      ...(this.accessMode !== undefined ? { accessMode: this.accessMode } : {}),
      ...(this.updates !== undefined ? { updates: this.updates } : {}) });
    child.attachVerifier((request) => {
      if (this.verifier === undefined) throw new Error(NO_VERIFIER);
      return this.verifier(request);
    });
    child.attachConsultant((request) => {
      if (this.consultant === undefined) throw new Error("The supreme consultation service is unavailable.");
      return this.consultant(request);
    });
    const publish = async (): Promise<readonly FactEntry[]> => {
      const entries = await child.entries();
      await this.publishView(key, snapshot, entries, child.ownDeletions());
      return entries;
    };
    return {
      ...(this.accessMode !== undefined ? { accessMode: this.accessMode } : {}),
      entries: async (signal) => {
        const work = publish();
        return signal === undefined ? work : abortable(work, signal);
      },
      submit: async (requester, submission, context) => {
        if (requester.taskId !== taskId) throw new Error("A private fact view belongs to one critic task.");
        const outcome = await child.submit(requester, submission, context);
        await publish();
        return outcome;
      },
      consult: async (requester, query, context) => {
        if (requester.taskId !== taskId) throw new Error("A private fact view belongs to one critic task.");
        const outcome = await child.consult(requester, query, context);
        await publish();
        return outcome;
      },
      evidence: async () => {
        await publish();
        return child.evidence();
      },
      ...(this.updates !== undefined ? { deletions: (signal?: AbortSignal) => child.deletions(signal) } : {}),
    };
  }

  /**
   * Publish private findings without treating isolated checks as shared badges.
   * A newly justified standing must be checked against the combined evidence by
   * the chair's global fact-table submission. The critic keeps its own verified
   * view; globally the existing disputed status prevents the duplicate shortcut
   * from bypassing that reconciliation.
   */
  private publishView(key: string, initial: readonly FactEntry[], entries: readonly FactEntry[],
    privateDeletions: readonly FactDeletion[] = []): Promise<void> {
    return this.locked(async () => {
      const previous = new Map((this.publishedViews.get(key) ?? initial).map((entry) => [entry.id, entry]));
      const changed: FactEntry[] = [];
      // A private ruling that revoked an entry deleted it from the view only.
      // It reaches the shared table as "disputed" (decision D3): nothing is
      // deleted there and no notice is sent until a ruling against the shared
      // table's combined evidence revokes it. An id the shared table has
      // deleted itself is never published again.
      for (const deletion of privateDeletions) {
        if (!previous.has(deletion.id) || this.deletionsById.has(deletion.id)) continue;
        const global = this.byId.get(deletion.id);
        if (global === undefined) continue;
        const at = this.now();
        changed.push({
          ...global,
          status: "disputed",
          updatedAt: Math.max(global.updatedAt, at),
          history: [...global.history, factEvent(at, "disputed", deletion.replacedBy ?? deletion.id, PRIVATE_REVOCATION)],
        });
      }
      const pendingSharedCheck = (entry: FactEntry): FactEntry => {
        if (entry.status !== "justified") return entry;
        const at = this.now();
        return {
          ...entry,
          status: "disputed",
          updatedAt: Math.max(entry.updatedAt, at),
          history: [...entry.history, factEvent(at, "disputed", entry.id,
            "Independently verified in a private review; pending verification against the shared table's combined evidence.")],
        };
      };
      for (const entry of entries) {
        const before = previous.get(entry.id);
        if (before !== undefined && JSON.stringify(before) === JSON.stringify(entry)) continue;
        if (this.deletionsById.has(entry.id)) continue;
        const global = this.byId.get(entry.id);
        if (global === undefined) {
          changed.push(pendingSharedCheck(entry));
          continue;
        }
        const ownChange = before === undefined || factStanding(before) !== factStanding(entry);
        const compatible = factStanding(global) === factStanding(entry)
          || (before !== undefined && factStanding(global) === factStanding(before));
        let merged = ownChange && compatible ? entry : global;
        const history = uniqueRecords([...global.history, ...entry.history]);
        if (ownChange && !compatible) {
          merged = { ...global, status: "disputed" };
          history.push(factEvent(this.now(), "disputed", entry.id,
            "Independent blind reviews changed this fact differently; its evidence requires reconciliation."));
        }
        const updated: FactEntry = {
          ...merged,
          updatedAt: Math.max(global.updatedAt, entry.updatedAt, ...history.map((event) => event.at)),
          history,
          requesters: uniqueRecords([...global.requesters, ...entry.requesters]),
        };
        // Mere reuse of a fact only adds audit history. A changed scientific
        // standing needs the shared check even if that private standing says
        // justified; it cannot override the table with an isolated verification.
        changed.push(ownChange ? pendingSharedCheck(updated) : updated);
      }
      if (changed.length === 0) return;
      // One durable line commits both the shared projection and the replay cursor.
      await this.append([{ type: "view-commit", entries: changed, view: { key, entries } }], true);
      this.version += 1;
      for (const entry of changed) {
        this.byId.set(entry.id, entry);
        this.changedAt.set(entry.id, this.version);
      }
      this.publishedViews.set(key, entries);
    });
  }

  async submit(
    requester: FactRequester,
    submission: FactSubmission,
    context: FactSubmitContext,
  ): Promise<FactSubmissionOutcome> {
    return this.submitChecked(requester, submission, context, true);
  }

  private async submitChecked(requester: FactRequester, submission: FactSubmission,
    context: FactSubmitContext, budgeted: boolean): Promise<FactSubmissionOutcome> {
    await this.loaded;
    if (this.persistenceError !== undefined) throw this.persistenceError;
    if (this.allocation !== undefined && this.nextSubmission > this.allocation.submissionThrough) {
      throw new Error("This private fact view exhausted its allocated submission identifiers.");
    }
    const id = `S:${this.nextSubmission++}`;
    if (!budgeted) this.unbudgetedSubmissions.add(id);
    // Refused before any check: no verifier, or the task's budget is spent.
    const verifier = this.verifier;
    if (verifier === undefined) return this.refuse(id, requester, submission, NO_VERIFIER);
    const made = this.submitted.get(requester.taskId) ?? 0;
    if (budgeted && made >= this.limits.submissionsPerTask) {
      return this.refuse(
        id,
        requester,
        submission,
        `This task has used its ${this.limits.submissionsPerTask} submissions; rely on lookups, ` +
          "or keep the argument conditional on the unverified premise; do not treat it as established.",
      );
    }
    if (budgeted) this.submitted.set(requester.taskId, made + 1);
    // An exact duplicate of a justified entry is answered from the table.
    const duplicate = this.accessMode === "supreme-mediated/v1" ? undefined : this.duplicateOf(submission);
    if (duplicate !== undefined) {
      const at = this.now();
      const badge = this.revise(duplicate, { event: factEvent(at, "relied", id), requester });
      return this.settle(
        at,
        id,
        requester,
        submission,
        { submission: id, case: "justified", badge, conflicts: [] },
        [badge],
      );
    }
    // The supreme judge rules against the table as it stands now; the ruling
    // commits under the mutex, after one more verification when an entry it
    // may rest on was created or changed in the meantime.
    let attempt = await this.verify(verifier, id, submission, context);
    const committed = this.locked(async () => {
      if (this.accessMode === "supreme-mediated/v1") context.signal?.throwIfAborted();
      if ("verdict" in attempt && this.movedSince(attempt.version, submission)) {
        attempt = await this.verify(verifier, id, submission, context, attempt);
      }
      return this.commit(id, requester, submission, attempt);
    });
    return context.signal !== undefined ? abortable(committed, context.signal) : committed;
  }

  private list(): FactEntry[] {
    return [...this.byId.values()].sort(byNumber);
  }

  private async load(): Promise<void> {
    const text = await readFileIfExists(this.logPath, DEFAULT_FS_DEADLINE_MS);
    if (text === undefined) {
      if (this.allocation !== undefined) throw new Error("The initialized private fact journal disappeared before it could be loaded.");
      if (this.allocation === undefined) {
        const directory = join(dirname(this.logPath), "fact-views");
        const groups = await withFsDeadline(readdir(directory), DEFAULT_FS_DEADLINE_MS, `reading ${directory}`)
          .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
        if (groups.length > 0) throw new Error("The shared fact journal is missing but private review views exist; refusing to reuse their identifiers.");
      }
      return;
    }
    const log = parseFactLog(text);
    for (const entry of log.entries) this.byId.set(entry.id, entry);
    this.nextFact = log.highestFact + 1;
    this.nextSubmission = log.highestSubmission + 1;
    this.openLine = log.openLine;
    this.directoryReady = true;
    for (const [key, entries] of log.publishedViews) this.publishedViews.set(key, entries);
    for (const [id, deletion] of log.deletions) this.deletionsById.set(id, deletion);
    for (const [id, entry] of log.lastStanding) this.lastStanding.set(id, entry);
    for (const [id, reason] of log.deletionReasons) this.deletionReasons.set(id, reason);
    if (this.strictWrites) {
      for (const stored of committedRecords(text)) {
        const record = stored as { type?: string; requester?: { taskId?: string }; budgeted?: boolean };
        if (record.type === "submission" && record.budgeted !== false && typeof record.requester?.taskId === "string") {
          const taskId = record.requester.taskId;
          this.submitted.set(taskId, (this.submitted.get(taskId) ?? 0) + 1);
        }
      }
    }
    if (this.accessMode === "supreme-mediated/v1") {
      for (const stored of committedRecords(text)) {
        const record = stored as { type?: string; approval?: FactUseApproval; id?: string; value?: JsonObject };
        if (record.type === "approval" && record.approval && typeof record.approval.id === "string") {
          this.approvals.set(record.approval.id, record.approval);
        } else if (record.type === "semantic-alias" && typeof record.id === "string" && record.value) {
          this.aliases.set(record.id, record.value);
        }
      }
    }
  }

  private refuse(
    id: string,
    requester: FactRequester,
    submission: FactSubmission,
    refusal: string,
  ): Promise<FactSubmissionOutcome> {
    return this.settle(
      this.now(),
      id,
      requester,
      submission,
      { submission: id, case: "unverified", conflicts: [], refusal },
      [],
    );
  }

  /** A justified entry stating the same claim under the same conditions (both normalized). */
  private duplicateOf(submission: FactSubmission): FactEntry | undefined {
    const claim = normalizeFactText(submission.claim);
    const conditions = normalizeFactText(submission.conditions);
    return this.list().find(
      (entry) =>
        entry.status === "justified" &&
        normalizeFactText(entry.claim) === claim &&
        normalizeFactText(entry.conditions) === conditions,
    );
  }

  /**
   * One run of the supreme judge against the table as it stands: the related
   * entries it is shown, the request without its requester, the ceiling, and
   * the checks of the ruling it returns.
   */
  private async verify(
    verifier: FactVerifier,
    id: string,
    submission: FactSubmission,
    context: FactSubmitContext,
    previous?: Attempt,
  ): Promise<Attempt> {
    const version = this.version;
    let related: FactEntry[] = this.accessMode === "supreme-mediated/v1" ? [] : rankFacts(
      this.list(),
      { claim: submission.claim, conditions: submission.conditions },
      this.limits.relatedFacts,
    ).map((hit) => hit.entry);
    const request: JsonObject = {
      claim: submission.claim,
      conditions: submission.conditions,
      evidence: submission.evidence,
      kind: submission.kind,
      ...(submission.step !== undefined ? { step: submission.step } : {}),
      ...(submission.purpose !== undefined ? { purpose: submission.purpose } : {}),
    };
    const ceilingMs = Math.max(1, Math.round(this.limits.verificationMinutes * 60_000));
    const ceiling = AbortSignal.timeout(ceilingMs);
    const signal =
      context.signal !== undefined ? AbortSignal.any([context.signal, ceiling]) : ceiling;
    // A second verification of the same submission adds to what the first spent.
    const spent = (usage: TokenUsage | undefined): { readonly usage?: TokenUsage } => {
      const total =
        usage !== undefined && previous?.usage !== undefined
          ? addUsage(previous.usage, usage)
          : (usage ?? previous?.usage);
      return total !== undefined ? { usage: total } : {};
    };
    let verification: FactVerification;
    try {
      if (this.accessMode === "supreme-mediated/v1") {
        const snapshot = this.list();
        const scan = await this.semanticScan(snapshot, { ...request, mode: "submit" }, { ...context, signal });
        await this.recordConsultation({ taskId: `fact-verification:${id}`, role: "supreme_judge", agent: "supreme_judge" },
          { ...request, mode: "submit" }, scan, snapshot);
        const selected = new Set(scan.matches.map((match) => match.factId));
        related = snapshot.filter((entry) => selected.has(entry.id));
      }
      verification = await abortable(
        verifier({
          submission: id,
          bindings: {
            input: context.input ?? {},
            files: context.files ?? [],
            request,
            related: related.map((entry) => this.accessMode === "supreme-mediated/v1"
              ? supremeFactView(entry) : factEntryView(entry, 1_200, true)),
          },
          ...(context.execution !== undefined ? { execution: context.execution } : {}),
          signal,
        }),
        signal,
      );
    } catch (error) {
      // The requester's own cancellation is no verdict: it propagates.
      if (context.signal?.aborted) throw error;
      const reason = ceiling.aborted
        ? `it did not finish within ${minutes(this.limits.verificationMinutes)}`
        : failureText(error);
      return {
        version,
        refusal: `The supreme judge could not complete the check: ${reason}.`,
        ...spent(undefined),
      };
    }
    const checked = { taskId: verification.taskId, ...spent(verification.usage) };
    const parsed = factVerdictSchema.safeParse(verification.verdict);
    if (!parsed.success) {
      return {
        version,
        refusal: `The supreme judge could not complete the check: ${failureText(parsed.error)}.`,
        ...checked,
      };
    }
    const verdict = parsed.data as FactVerdict;
    // What the schema cannot check: the ruling names only entries the judge
    // was shown, and points the requester only at an entry that is a badge.
    const shown = new Map(related.map((entry) => [entry.id, entry]));
    if (
      (verdict.existing !== undefined && shown.get(verdict.existing)?.status !== "justified") ||
      verdict.conflicts.some((ruling) => !shown.has(ruling.id))
    ) {
      return { version, refusal: UNSHOWN_ENTRIES, ...checked };
    }
    return { version, verdict, ...checked };
  }

  /** Whether an entry created or changed since `version` ranks against the claim. */
  private movedSince(version: number, submission: FactSubmission): boolean {
    if (this.version === version) return false;
    if (this.accessMode === "supreme-mediated/v1") return true;
    return rankFacts(
      this.list(),
      { claim: submission.claim, conditions: submission.conditions },
      this.limits.relatedFacts,
    ).some((hit) => (this.changedAt.get(hit.entry.id) ?? 0) > version);
  }

  /** A ruling's effects, applied in one synchronous step, then recorded. */
  private commit(
    id: string,
    requester: FactRequester,
    submission: FactSubmission,
    attempt: Attempt,
  ): Promise<FactSubmissionOutcome> {
    const at = this.now();
    if ("refusal" in attempt) {
      return this.settle(
        at,
        id,
        requester,
        submission,
        { submission: id, case: "unverified", conflicts: [], refusal: attempt.refusal },
        [],
        attempt,
      );
    }
    const verdict = attempt.verdict;
    const ruled: Ruled = { at, id, requester, submission, verdict };
    const deleting = this.updates !== undefined;
    // Every entry the ruling creates or changes, in the order its snapshot is
    // written (a new entry before the incumbents that point at it), and those
    // whose standing moved.
    const changed: string[] = [];
    const moved: string[] = [];
    const note = (entry: FactEntry, standing: boolean): FactEntry => {
      if (!changed.includes(entry.id)) changed.push(entry.id);
      if (standing && !moved.includes(entry.id)) moved.push(entry.id);
      return entry;
    };
    let badge: FactEntry | undefined;
    let recorded: FactEntry | undefined;
    switch (verdict.case) {
      case "justified":
        badge = note(
          this.revise(this.byId.get(verdict.existing!)!, {
            event: factEvent(at, "relied", id, verdict.explanation),
            requester,
          }),
          false,
        );
        break;
      case "justified-new":
      case "narrowed":
        badge = note(this.create(ruled, "justified", "issued"), true);
        break;
      case "conflict":
        // A disputed incumbent: the submission's claim enters beside it, disputed too.
        if (verdict.conflicts.some((ruling) => ruling.resolution === "disputed")) {
          recorded = note(this.create(ruled, "disputed", "disputed"), true);
        }
        break;
      case "refuted":
        // With fact updates a refuted claim never enters the table (decision D2):
        // only the submitter knows it, from this ruling's answer.
        if (!deleting) recorded = note(this.create(ruled, "refuted", "refuted"), true);
        break;
      default:
        // "unverified" and "not-a-fact": nothing enters the table.
        break;
    }
    // With fact updates a revoked incumbent is deleted, in this same step: it
    // leaves the table, and its deletion marker joins the ruling's records.
    const deletions: { readonly deletion: StoredDeletion; readonly entry: FactEntry; readonly reason: string }[] = [];
    for (const ruling of verdict.conflicts) {
      const incumbent = this.byId.get(ruling.id)!;
      if (deleting && ruling.resolution === "incumbent-revoked") {
        this.byId.delete(incumbent.id);
        this.changedAt.delete(incumbent.id);
        const deletion: StoredDeletion = { id: incumbent.id, seq: this.ownDeletions().length + 1, at,
          ...(badge !== undefined ? { replacedBy: badge.id } : {}) };
        this.deletionsById.set(incumbent.id, deletion);
        this.lastStanding.set(incumbent.id, incumbent);
        this.deletionReasons.set(incumbent.id, { reason: ruling.explanation, submission: id });
        deletions.push({ deletion, entry: incumbent, reason: ruling.explanation });
        continue;
      }
      switch (ruling.resolution) {
        case "incumbent-stands":
          note(
            this.revise(incumbent, { event: factEvent(at, "upheld", id, ruling.explanation) }),
            false,
          );
          break;
        case "incumbent-revoked":
          note(
            this.revise(incumbent, {
              event: factEvent(at, "revoked", badge?.id ?? id, ruling.explanation),
              status: "revoked",
              ...(badge !== undefined ? { supersededBy: badge.id } : {}),
            }),
            true,
          );
          break;
        case "both-narrowed":
          note(
            this.revise(incumbent, {
              event: factEvent(at, "narrowed", badge?.id ?? id, ruling.explanation),
              conditions: ruling.conditions ?? incumbent.conditions,
            }),
            true,
          );
          break;
        case "disputed":
          note(
            this.revise(incumbent, {
              event: factEvent(at, "disputed", recorded?.id ?? id, ruling.explanation),
              status: "disputed",
            }),
            true,
          );
          break;
      }
    }
    if (moved.length > 0 || deletions.length > 0) {
      this.version += 1;
      for (const entryId of moved) this.changedAt.set(entryId, this.version);
    }
    const current = (entryId: string): FactEntry => this.byId.get(entryId)!;
    const deletedEntries = new Map(deletions.map((item) => [item.entry.id, item.entry]));
    return this.settle(
      at,
      id,
      requester,
      submission,
      {
        submission: id,
        case: verdict.case,
        ...(badge !== undefined ? { badge: current(badge.id) } : {}),
        verdict,
        conflicts: verdict.conflicts.map((ruling) => {
          // A deleted incumbent is answered as it stood, marked deleted.
          const deletedEntry = deletedEntries.get(ruling.id);
          return {
            entry: deletedEntry ?? current(ruling.id),
            resolution: ruling.resolution,
            explanation: ruling.explanation,
            ...(deletedEntry !== undefined ? { deleted: true } : {}),
          };
        }),
        ...(recorded !== undefined ? { recorded: current(recorded.id) } : {}),
      },
      changed.map(current),
      attempt,
      deletions.map((item) => item.deletion),
      // Once the ruling's records are durable (a failed strict write throws
      // before this), each deletion is announced to the update listeners.
      () => {
        for (const item of deletions) {
          const replacement = item.deletion.replacedBy !== undefined ? this.byId.get(item.deletion.replacedBy) : undefined;
          this.announce({ deletion: this.publicDeletion(item.deletion), entry: item.entry, reason: item.reason,
            ...(replacement !== undefined ? { replacement } : {}), submission: id });
        }
      },
    );
  }

  /** Tells every update listener of one durable deletion; a listener's failure never undoes the ruling. */
  private announce(event: FactUpdateEvent): void {
    for (const listener of this.updateListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[worker] fact-update listener failed for ${event.deletion.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** A new entry for the submission's claim as the supreme judge stated it. */
  private create(ruled: Ruled, status: FactStatus, first: FactEvent["event"]): FactEntry {
    const { at, id, requester, submission, verdict } = ruled;
    if (this.allocation !== undefined && this.nextFact > this.allocation.factThrough) {
      throw new Error("This private fact view exhausted its allocated fact identifiers.");
    }
    const entry: FactEntry = {
      id: `F:${this.nextFact++}`,
      status,
      kind: submission.kind,
      claim: verdict.claim,
      conditions: verdict.conditions,
      method: verdict.method,
      evidence: verdict.evidence,
      createdAt: at,
      updatedAt: at,
      history: [factEvent(at, first, id, verdict.explanation)],
      requesters: [requester],
    };
    const stored = this.accessMode === "supreme-mediated/v1" ? { ...entry, badgeHash: factBadgeHash(entry) } : entry;
    this.byId.set(stored.id, stored);
    return stored;
  }

  /** The entry with one more event, and the changes that event records. */
  private revise(entry: FactEntry, revision: Revision): FactEntry {
    const { event, requester } = revision;
    const supersededBy = revision.supersededBy ?? entry.supersededBy;
    const requesters =
      requester === undefined || entry.requesters.some((known) => sameRequester(known, requester))
        ? entry.requesters
        : [...entry.requesters, requester];
    const revised: FactEntry = {
      id: entry.id,
      status: revision.status ?? entry.status,
      kind: entry.kind,
      claim: entry.claim,
      conditions: revision.conditions ?? entry.conditions,
      method: entry.method,
      evidence: entry.evidence,
      createdAt: entry.createdAt,
      updatedAt: event.at,
      ...(supersededBy !== undefined ? { supersededBy } : {}),
      history: [...entry.history, event],
      requesters,
    };
    const stored = this.accessMode === "supreme-mediated/v1" ? { ...revised, badgeHash: factBadgeHash(revised) } : revised;
    this.byId.set(stored.id, stored);
    return stored;
  }

  /** Records one submission (the snapshots of what it changed, then its own line). */
  private async settle(
    at: number,
    id: string,
    requester: FactRequester,
    submission: FactSubmission,
    outcome: FactSubmissionOutcome,
    changed: readonly FactEntry[],
    attempt?: Attempt,
    deletions: readonly StoredDeletion[] = [],
    onDurable?: () => void,
  ): Promise<FactSubmissionOutcome> {
    const durable = await this.append([
      ...changed.map((entry) => ({ type: "entry", at, entry })),
      ...deletions.map((deletion) => ({ type: "deletion", ...deletion })),
      {
        type: "submission",
        at,
        id,
        requester,
        submission,
        case: outcome.case,
        ...(this.unbudgetedSubmissions.has(id) ? { budgeted: false } : {}),
        ...(outcome.badge !== undefined ? { badge: outcome.badge.id } : {}),
        ...(outcome.recorded !== undefined ? { recorded: outcome.recorded.id } : {}),
        conflicts: outcome.conflicts.map((conflict) => ({
          id: conflict.entry.id,
          resolution: conflict.resolution,
        })),
        ...(outcome.verdict !== undefined ? { verdict: outcome.verdict } : {}),
        ...(attempt?.taskId !== undefined ? { verifierTaskId: attempt.taskId } : {}),
        ...(outcome.refusal !== undefined ? { refusal: outcome.refusal } : {}),
        ...(attempt?.usage !== undefined ? { usage: attempt.usage } : {}),
      },
    ]);
    if (durable && onDurable !== undefined) onDurable();
    return outcome;
  }

  /**
   * Appends `records` behind every earlier append, one write per line. A
   * Legacy writes are best-effort. A strict write is one atomic log record;
   * failure invalidates the view until it is reopened from its durable log.
   */
  private append(records: readonly object[], strict = this.strictWrites): Promise<boolean> {
    const written = this.writes.then(async () => {
      if (this.persistenceError !== undefined) throw this.persistenceError;
      const durable = strict && records.length > 1 ? [{ type: "transaction", records }] : records;
      let all = true;
      for (const record of durable) {
        try {
          // A strict journal must permanently invalidate an uncommitted tail.
          // Merely adding a newline could resurrect complete JSON whose final
          // newline was lost, after load() deliberately ignored it.
          const prefix = this.openLine ? (strict ? "!\n" : "\n") : "";
          const line = `${prefix}${JSON.stringify(record)}\n`;
          if (!this.directoryReady) {
            await withFsDeadline(
              mkdir(dirname(this.logPath), { recursive: true }),
              DEFAULT_FS_DEADLINE_MS,
              `creating the directory of ${this.logPath}`,
            );
            this.directoryReady = true;
          }
          await withFsDeadline(
            appendFile(this.logPath, line, "utf8"),
            DEFAULT_FS_DEADLINE_MS,
            `appending to ${this.logPath}`,
          );
          this.openLine = false;
          this.writeFailing = false;
        } catch (error) {
          // A write that failed part-way may have left half a line behind.
          this.openLine = true;
          if (!this.writeFailing) {
            console.error(
              `[worker] fact table could not record to ${this.logPath}: ${
                error instanceof Error ? error.message : String(error)
              } — ${strict ? "this view is unavailable until it is reopened from disk" : "its rulings stand for this process, but a resume will not see them"}`,
            );
          }
          this.writeFailing = true;
          all = false;
          if (strict) {
            this.persistenceError = error;
            throw error;
          }
        }
      }
      return all;
    });
    this.writes = written.then(() => undefined, () => undefined);
    return written;
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> => {
      if (this.persistenceError !== undefined) return Promise.reject(this.persistenceError);
      return work();
    };
    const result = this.commits.then(guarded, guarded);
    this.commits = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
