import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactDeletionView, FactEntryView, FactTableView, FactUpdateSubscriberView, FactUpdateView, TokenUsageView } from "@brainstorm-agentic/protocol";
import { readJsonlCached, statStamp } from "./read-cache.js";
import { factUsageViews, type FactUsageContext } from "./fact-usage.js";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const factId = (value: unknown): value is string => typeof value === "string" && /^F:[1-9][0-9]*$/.test(value);
const statuses = new Set(["justified", "disputed", "revoked", "refuted"]);
const kinds = new Set(["code", "record", "result", "literature", "math", "background"]);
const methods = new Set(["re-executed", "source-quoted", "record-match", "judgement-only", "none"]);
const events = new Set(["issued", "relied", "upheld", "narrowed", "revoked", "disputed", "refuted"]);

function entryView(raw: unknown): FactEntryView | undefined {
  if (!object(raw) || !factId(raw.id) || typeof raw.status !== "string" || !statuses.has(raw.status) || typeof raw.kind !== "string" || !kinds.has(raw.kind) ||
      typeof raw.method !== "string" || !methods.has(raw.method) || !timestamp(raw.createdAt) || !timestamp(raw.updatedAt) ||
      !Array.isArray(raw.history) || !Array.isArray(raw.requesters) ||
      ![raw.claim, raw.conditions, raw.evidence].every((value) => typeof value === "string")) return undefined;
  const history: FactEntryView["history"][number][] = [];
  for (const event of raw.history) {
    if (!object(event) || !timestamp(event.at) || typeof event.event !== "string" || !events.has(event.event)) continue;
    history.push({ at: event.at, event: event.event as FactEntryView["history"][number]["event"],
      ...(typeof event.by === "string" ? { by: event.by } : {}),
      ...(typeof event.detail === "string" ? { detail: event.detail } : {}),
    });
  }
  const reason = history.find((event) => event.event === "issued" || event.event === "refuted")?.detail;
  return {
    id: raw.id, status: raw.status as FactEntryView["status"], kind: raw.kind as FactEntryView["kind"],
    claim: raw.claim as string, conditions: raw.conditions as string, method: raw.method as FactEntryView["method"], evidence: raw.evidence as string,
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, history,
    ...(typeof raw.badgeHash === "string" && /^sha256:[a-f0-9]{64}$/.test(raw.badgeHash) ? { badgeHash: raw.badgeHash } : {}),
    ...(reason ? { reason } : {}), ...(factId(raw.supersededBy) ? { supersededBy: raw.supersededBy } : {}),
  };
}

/** Read the shared journal only. Private view snapshots, approval receipts and
 * historical badge revisions are not replacements for the latest shared entry. */
export function readFactTableView(sessionDir: string, context: FactUsageContext = {}): FactTableView | undefined {
  let readError: unknown;
  const records = readJsonlCached(join(sessionDir, "facts.jsonl"), (error) => { readError = error; });
  if (object(readError) && readError.code === "ENOENT") return undefined;
  const entries = new Map<string, FactEntryView>();
  const shared = new Map<string, Record<string, unknown>>();
  const committed: Record<string, unknown>[] = [];
  const deletions = new Map<string, FactDeletionView>();
  const apply = (raw: unknown): void => {
    if (!object(raw)) return;
    committed.push(raw);
    if (raw.type === "entry") {
      const entry = entryView(raw.entry);
      // A deleted id never returns: later snapshots of it are ignored, as the worker's loader ignores them.
      if (entry && !deletions.has(entry.id)) { entries.set(entry.id, entry); shared.set(entry.id, raw.entry as Record<string, unknown>); }
    } else if (raw.type === "view-commit" && Array.isArray(raw.entries)) {
      const changes = raw.entries.map(entryView);
      // A shared view commit is one atomic set, not its private `view.entries`.
      if (changes.every((entry) => entry !== undefined)) changes.forEach((entry, index) => {
        if (deletions.has(entry.id)) return;
        entries.set(entry.id, entry); shared.set(entry.id, (raw.entries as Record<string, unknown>[])[index]!);
      });
    } else if (raw.type === "deletion" && factId(raw.id) && timestamp(raw.at)) {
      // Logical deletion: the entry leaves the view with its uses and history;
      // only its id, the time and the replacement badge remain, never its claim or reason.
      entries.delete(raw.id); shared.delete(raw.id);
      if (!deletions.has(raw.id)) deletions.set(raw.id, { id: raw.id, at: raw.at, ...(factId(raw.replacedBy) ? { replacedBy: raw.replacedBy } : {}) });
    }
  };
  for (const raw of records) {
    if (object(raw) && raw.type === "transaction") {
      if (Array.isArray(raw.records) && raw.records.every(object)) raw.records.forEach(apply);
    } else apply(raw);
  }
  const uses = factUsageViews(committed, shared, context);
  const updates = factUpdateViews(readFactUpdateJournal(sessionDir), context.journal ?? []);
  return {
    entries: [...entries.values()].map((entry) => ({ ...entry, uses: uses.get(entry.id) ?? [] })).sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)),
    ...(readError !== undefined ? { error: "The fact table journal could not be read." } : {}),
    ...(deletions.size > 0 ? { deleted: [...deletions.values()] } : {}),
    ...(updates.length > 0 ? { updates } : {}),
  };
}

/** One deletion notice of the fact-update journal, without its text. */
export interface FactNotice {
  readonly id: string;
  readonly deleted: string;
  readonly replacedBy?: string;
  readonly at: number;
  readonly subscribers: readonly string[];
  /** The run's fact updates were closed before this notice: it started no task. */
  readonly afterClose: boolean;
}

/** One reconsideration task of the spawner journal, with its supersession and result. */
export interface FactUpdateTask {
  readonly key: string;
  readonly taskId: string;
  readonly notices: readonly string[];
  superseded: boolean;
  result?: { readonly status: "ok" | "error"; readonly decision?: string; readonly usage?: TokenUsageView };
}

/** What `fact-updates.jsonl` (the spawner journal next to `facts.jsonl`) records, in journal order. */
export interface FactUpdateJournal {
  readonly notices: readonly FactNotice[];
  readonly tasks: readonly FactUpdateTask[];
}

const noticeId = (value: unknown): value is string => typeof value === "string" && /^N:[1-9][0-9]*$/.test(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

/** The token usage record of a journal line, when well-formed. */
function usageOf(value: unknown): TokenUsageView | undefined {
  if (!object(value) || typeof value.inputTokens !== "number" || typeof value.outputTokens !== "number") return undefined;
  const number = (candidate: unknown): candidate is number => typeof candidate === "number";
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(number(value.totalTokens) ? { totalTokens: value.totalTokens } : {}),
    ...(number(value.cacheReadInputTokens) ? { cacheReadInputTokens: value.cacheReadInputTokens } : {}),
    ...(number(value.cacheWriteInputTokens) ? { cacheWriteInputTokens: value.cacheWriteInputTokens } : {}),
    ...(number(value.reasoningTokens) ? { reasoningTokens: value.reasoningTokens } : {}),
  };
}

/** Reads the spawner journal. Notice texts (claims and reasons of deleted badges) are never read. */
export function readFactUpdateJournal(sessionDir: string): FactUpdateJournal {
  const notices: FactNotice[] = [];
  const tasks: FactUpdateTask[] = [];
  const byTaskId = new Map<string, FactUpdateTask>();
  let closed = false;
  for (const raw of readJsonlCached(join(sessionDir, "fact-updates.jsonl"))) {
    if (!object(raw)) continue;
    if (raw.type === "notice" && noticeId(raw.id) && factId(raw.deleted) && timestamp(raw.at)) {
      notices.push({ id: raw.id, deleted: raw.deleted, ...(factId(raw.replacedBy) ? { replacedBy: raw.replacedBy } : {}), at: raw.at,
        subscribers: strings(raw.subscribers), afterClose: closed });
    } else if (raw.type === "task" && typeof raw.key === "string" && typeof raw.taskId === "string") {
      const task: FactUpdateTask = { key: raw.key, taskId: raw.taskId, notices: strings(raw.notices).filter(noticeId), superseded: false };
      tasks.push(task); byTaskId.set(task.taskId, task);
    } else if (raw.type === "supersede") {
      for (const taskId of strings(raw.taskIds)) { const task = byTaskId.get(taskId); if (task) task.superseded = true; }
    } else if (raw.type === "result" && typeof raw.taskId === "string" && (raw.status === "ok" || raw.status === "error")) {
      const task = byTaskId.get(raw.taskId);
      const decision = object(raw.output) && typeof raw.output.decision === "string" ? raw.output.decision : undefined;
      const usage = usageOf(raw.usage);
      if (task) task.result = { status: raw.status, ...(decision !== undefined ? { decision } : {}), ...(usage ? { usage } : {}) };
    } else if (raw.type === "closed") closed = true;
  }
  return { notices, tasks };
}

/** The merge nodes of the fact-update design (6.3); their journaled outputs name the tasks a merge discarded. */
const FACT_MERGE_NODES = new Set(["game-apply-fact-updates", "apply-fact-updates", "apply-fact-updates-after-review",
  "apply-fact-updates-before-synthesis", "game-apply-report-updates", "game-apply-late-report-updates",
  "apply-comment-updates", "apply-late-comment-updates"]);

/** A fact-update merge node's journaled output (schema factUpdateMerge), or undefined for any other entry. */
export function factMergeOf(entry: { readonly key: string; readonly value?: unknown }): { readonly node: string; readonly value: Record<string, unknown> } | undefined {
  const match = /\/([a-z-]+)\/\1-run::result$/.exec(entry.key);
  if (!match || !FACT_MERGE_NODES.has(match[1]!) || !object(entry.value)) return undefined;
  return { node: match[1]!, value: entry.value };
}

/** A subscriber key of the spawner journal: chain:<seat>, game-report|comment:<seat>:<step>:<round>:<critic>, none:<role>:<agent>. */
function subscriberOf(key: string): Omit<FactUpdateSubscriberView, "state"> | undefined {
  const parts = key.split(":");
  const kind = parts[0];
  const count = (value: string | undefined): number | undefined => value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : undefined;
  if (kind === "chain") {
    const seat = parts[1];
    return parts.length === 2 && seat ? { key, kind, agentId: seat, seatId: seat } : undefined;
  }
  if (kind === "game-report" || kind === "comment") {
    const [, seat, stepText, roundText, critic] = parts;
    const step = count(stepText);
    const round = count(roundText);
    if (parts.length !== 5 || !seat || !critic || step === undefined || round === undefined) return undefined;
    return { key, kind, agentId: critic, seatId: seat, step, round };
  }
  if (kind === "none") {
    const agent = parts.slice(2).join(":");
    return parts.length >= 3 && parts[1] && agent ? { key, kind, agentId: agent } : undefined;
  }
  return undefined;
}

/** Notices and the state of each subscriber's reconsideration; never a claim or reason of a deleted badge. */
export function factUpdateViews(journal: FactUpdateJournal, workflow: readonly { readonly key: string; readonly value?: unknown }[]): FactUpdateView[] {
  // A merge discards a result whose report changed, whose seat was dismissed, or that a later task superseded.
  const discarded = new Set<string>();
  for (const entry of workflow) {
    const merge = factMergeOf(entry);
    const items: unknown[] = merge !== undefined && Array.isArray(merge.value.discarded) ? merge.value.discarded : [];
    for (const item of items) {
      if (object(item) && typeof item.taskId === "string") discarded.add(item.taskId);
    }
  }
  const stateOf = (key: string, notice: FactNotice): FactUpdateSubscriberView["state"] => {
    if (key.startsWith("none:")) return "no-task";
    // The latest task of this subscriber that covers the notice: a superseding task covers every unmerged notice of its key.
    const task = [...journal.tasks].reverse().find((candidate) => candidate.key === key && candidate.notices.includes(notice.id));
    if (task === undefined) return notice.afterClose ? "no-task" : "running";
    if (task.superseded || discarded.has(task.taskId)) return "discarded";
    if (task.result === undefined) return "running";
    if (task.result.status === "error") return "failed";
    return task.result.decision === "withdrawn" ? "withdrawn" : task.result.decision === "unchanged" ? "unchanged" : "applied";
  };
  return journal.notices.map((notice) => ({
    notice: notice.id, deleted: notice.deleted, ...(notice.replacedBy !== undefined ? { replacedBy: notice.replacedBy } : {}), at: notice.at,
    subscribers: notice.subscribers.flatMap((key) => {
      const subscriber = subscriberOf(key);
      return subscriber ? [{ ...subscriber, state: stateOf(key, notice) }] : [];
    }),
  }));
}

/** A fact-table model call's recorded spend, with the workflow task it served. */
export interface FactCallUsage {
  /** The requester of a verification or consultation, or the reconsideration task itself (`fact-update:...`). */
  readonly taskId: string;
  readonly usage: TokenUsageView;
}

/** Committed records of a strict fact journal's text: complete lines only, transactions expanded. */
function committedRecords(lines: readonly unknown[]): Record<string, unknown>[] {
  return lines.flatMap((raw) => !object(raw) ? []
    : raw.type === "transaction" ? (Array.isArray(raw.records) && raw.records.every(object) ? raw.records as Record<string, unknown>[] : [])
    : [raw]);
}

/** Private journals by path, cached by stat stamp apart from the shared JSONL cache, whose few slots the event log needs. */
const privateJournals = new Map<string, { readonly stamp: string; readonly records: readonly Record<string, unknown>[] }>();
const MAX_PRIVATE_JOURNALS = 4096;

function privateJournal(path: string): readonly Record<string, unknown>[] {
  const stamp = statStamp(path);
  if (stamp === undefined) { privateJournals.delete(path); return []; }
  const cached = privateJournals.get(path);
  if (cached?.stamp === stamp) return cached.records;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return cached?.records ?? []; }
  const lines: unknown[] = [];
  // A partial last line is a write in progress; a poisoned one fails to parse.
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try { lines.push(JSON.parse(line)); } catch { /* an uncommitted tail */ }
  }
  const records = committedRecords(lines);
  privateJournals.delete(path);
  privateJournals.set(path, { stamp, records });
  if (privateJournals.size > MAX_PRIVATE_JOURNALS) {
    const oldest = privateJournals.keys().next().value;
    if (oldest !== undefined) privateJournals.delete(oldest);
  }
  return records;
}

/** Every private journal under `fact-views/` (one directory per blind-review group). */
function privateJournalPaths(sessionDir: string): string[] {
  const root = join(sessionDir, "fact-views");
  const directories = (path: string): string[] => {
    try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return []; }
  };
  const journals = (path: string): string[] => {
    try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => entry.name).sort(); } catch { return []; }
  };
  return directories(root).flatMap((group) => journals(join(root, group)).map((name) => join(root, group, name)));
}

/**
 * The spend of the fact table's model calls, none of which is a workflow task:
 * each verification (`submission` lines) and each supreme-judge consultation
 * (`consultation` lines: lookups, status checks, approvals and the scans inside
 * submissions) of the shared journal and of every private journal, attributed to
 * the task that requested it, and each reconsideration task of `fact-updates.jsonl`.
 */
export function factCallUsage(sessionDir: string): FactCallUsage[] {
  const calls: FactCallUsage[] = [];
  const journals = [committedRecords(readJsonlCached(join(sessionDir, "facts.jsonl"))), ...privateJournalPaths(sessionDir).map(privateJournal)];
  for (const records of journals) {
    // A submission's scan is recorded with the verification as its requester; it counts for the submission's requester.
    const requesters = new Map<string, string>();
    for (const record of records) {
      if (record.type === "submission" && typeof record.id === "string" && object(record.requester) && typeof record.requester.taskId === "string") {
        requesters.set(record.id, record.requester.taskId);
      }
    }
    const verifications = new Set<string>();
    for (const record of records) {
      if (record.type !== "submission" && record.type !== "consultation") continue;
      const usage = usageOf(record.usage);
      const requester = object(record.requester) && typeof record.requester.taskId === "string" ? record.requester.taskId : undefined;
      if (!usage || requester === undefined) continue;
      if (record.type === "submission") {
        // One line per submission; a repeated verifier task id is the same spend.
        if (typeof record.verifierTaskId === "string") {
          if (verifications.has(record.verifierTaskId)) continue;
          verifications.add(record.verifierTaskId);
        }
        calls.push({ taskId: requester, usage });
        continue;
      }
      const scan = /^fact-verification:(S:[1-9][0-9]*)$/.exec(requester);
      const taskId = scan ? requesters.get(scan[1]!) : requester;
      if (taskId !== undefined) calls.push({ taskId, usage });
    }
  }
  for (const task of readFactUpdateJournal(sessionDir).tasks) {
    if (task.result?.usage) calls.push({ taskId: task.taskId, usage: task.result.usage });
  }
  return calls;
}
