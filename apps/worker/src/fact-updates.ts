/**
 * Fact updates, the worker's side (spec/fact-updates.md v2 with the user's
 * decisions D1-D15 of 2026-10-14): the spawner of reconsideration tasks.
 *
 * When the run's shared fact table deletes a badge, the spawner composes the
 * notice from the ruling (design 4.1), asks the runtime's subscriber index who
 * cites the badge (3.1), and starts every subscriber's reconsideration task at
 * once, in parallel and with no cap of its own (6.2). The workflow's merge
 * points wait here for the tasks they need and return what to merge (6.3); a
 * merge is a journaled workflow effect, so replay folds it again and never
 * waits. The spawner's own journal, `fact-updates.jsonl` beside the run's
 * `facts.jsonl`, is what a resume continues from (6.1, 6.7).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  emptyFactUpdateMerge,
  parseSubscriberKey,
  reportBase,
  staleChainParts,
  citedSteps,
  chainSubscriberKey,
  validateArtifact,
  type CompiledContentWorkflow,
  type FactMergeRequest,
  type FactNotice,
  type FactStoredOutput,
  type FactUpdateCoordinator,
  type FactUpdateIndex,
  type FactUpdateSubmitter,
} from "@brainstorm-agentic/brainstorm-runtime";
import {
  factIssuanceReason,
  WindDownSignal,
  WorkflowCancelledError,
  type AgentExecutor,
  type AgentTask,
  type FactDeletion,
  type FactUpdateEvent,
  type JsonObject,
  type JsonValue,
} from "@brainstorm-agentic/core";

import { DEFAULT_FS_DEADLINE_MS, readFileIfExists, withFsDeadline } from "./fs-stores.js";

/** The node id reconsideration tasks are built and validated under. */
const FACT_UPDATE_NODE = "fact-update";

/** What the spawner reads from the run's shared fact table (FileFactTable). */
export interface FactUpdateTable {
  deletionEpoch(): Promise<number>;
  deletions(): Promise<readonly FactDeletion[]>;
  updateEvents(): Promise<readonly FactUpdateEvent[]>;
}

export interface FactUpdateSpawnerOptions {
  /** The run the spawner serves. */
  readonly runId: string;
  /** `<session>/<runId>/fact-updates.jsonl`, in the directory of the run's `facts.jsonl`. */
  readonly journalPath: string;
  readonly table: FactUpdateTable;
  /** The compiled workflow's subscriber index and task builder. */
  readonly compiled: Pick<CompiledContentWorkflow, "factUpdateIndex" | "factReconsiderationTask">;
  /** The run's outermost executor: launches are spaced, captured and scoped as for any task. */
  readonly executor: AgentExecutor;
  /** The host's deadline: no task starts after it (design 6.8). */
  readonly windDown?: { readonly at: number; readonly reason: string };
  /** Cancels every running task (design 6.8). */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

interface NoticeState {
  readonly id: string;
  readonly seq: number;
  readonly deleted: string;
  /** The notice as journaled: 4.1 without `citedAt`. */
  readonly notice: FactNotice;
}

type TaskOutcome =
  | { readonly status: "ok"; readonly output: JsonObject }
  | { readonly status: "error"; readonly error: string; readonly thrown?: unknown };

interface TaskState {
  readonly key: string;
  readonly taskId: string;
  readonly notices: readonly string[];
  readonly epoch: number;
  readonly base: JsonObject;
  superseded: boolean;
  /** Returned by a merge point of this process (merged or discarded). */
  handed: boolean;
  /** Listed by a merge point of this process as superseded. */
  listed: boolean;
  /** Settles when the task ends; absent for a task an earlier process journaled. */
  run?: Promise<void>;
  outcome?: TaskOutcome;
  /** Stops the task's executor call: the spawner's close, or its run invocation's abort (D16). */
  stop?: AbortController;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The fact-update spawner (design section 6). It implements the runtime's
 * FactUpdateCoordinator for the merge points, listens to the shared table's
 * deletions (`onDeletion`), and is told of outputs stored live (`stored`).
 */
export class FactUpdateSpawner implements FactUpdateCoordinator {
  private readonly runId: string;
  private readonly journalPath: string;
  private readonly table: FactUpdateTable;
  private readonly index: FactUpdateIndex;
  private readonly build: NonNullable<CompiledContentWorkflow["factReconsiderationTask"]>;
  private readonly executor: AgentExecutor;
  private readonly windDown: { readonly at: number; readonly reason: string } | undefined;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private readonly notices = new Map<string, NoticeState>();
  private readonly noticeByDeleted = new Map<string, NoticeState>();
  private readonly tasks = new Map<string, TaskState>();
  private readonly byKey = new Map<string, TaskState[]>();
  private readonly attempts = new Map<string, number>();
  /** Report rounds whose late merge this process has returned: no new task (D14). */
  private readonly closedRounds = new Set<string>();
  /** Keys whose task could not start after the wind-down deadline. */
  private readonly blocked = new Set<string>();
  /**
   * Deletions the table recorded without a notice in the journal (a crash
   * between the two, design 6.7), until their notice is journaled: by the
   * listener when the deletion is announced while the journal loads, else
   * before the next merge point or stored output looks for subscribers.
   */
  private readonly pending = new Map<string, FactUpdateEvent>();
  private closed = false;
  /** The current run invocation's abort signal (D16); absent until a run binds it. */
  private runSignal: AbortSignal | undefined;
  /** Counts the run invocations bound so far (D16). */
  private invocation = 0;
  private readonly loaded: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private writes: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private openLine = false;
  private directoryReady = false;

  constructor(options: FactUpdateSpawnerOptions) {
    const index = options.compiled.factUpdateIndex;
    const build = options.compiled.factReconsiderationTask;
    if (index === undefined || build === undefined) {
      throw new Error("this bundle declares no fact updates");
    }
    this.runId = options.runId;
    this.journalPath = options.journalPath;
    this.table = options.table;
    this.index = index;
    this.build = build;
    this.executor = options.executor;
    this.windDown = options.windDown;
    this.now = options.now ?? Date.now;
    if (options.signal !== undefined) {
      const signal = options.signal;
      if (signal.aborted) this.controller.abort(signal.reason);
      else signal.addEventListener("abort", () => this.controller.abort(signal.reason), { once: true });
    }
    this.loaded = this.load();
    // A failed load fails the next merge point, not the process.
    this.loaded.catch((error: unknown) => {
      this.failure ??= error;
    });
  }

  /** The table's update listener (design 2.1): one call per durable deletion. */
  onDeletion(event: FactUpdateEvent): void {
    this.enqueue(async () => {
      if (this.noticeByDeleted.has(event.deletion.id)) return;
      this.pending.delete(event.deletion.id);
      const submitter = this.submitterOf(event);
      const found = this.closed
        ? { subscribers: [] }
        : this.index.subscribersOf(this.runId, event.deletion.id, submitter, event.deletion.seq);
      const subscribers = found.subscribers.filter((subscriber) => !this.isRoundClosed(subscriber.key));
      const notice = await this.recordNotice(event, [
        ...subscribers.map((subscriber) => subscriber.key),
        ...("none" in found && found.none !== undefined ? [found.none] : []),
      ]);
      await this.startAll(subscribers.map((subscriber) => ({ key: subscriber.key, notices: [notice.id] })));
    });
  }

  /** An output stored by a task that ran in this process (detection path 2, design 3.4). */
  stored(output: FactStoredOutput): void {
    if (output.runId !== this.runId) return;
    this.enqueue(() => this.ensure([output.key]));
  }

  /**
   * A merge point (design 6.3): waits for the tasks the point needs, checks
   * them against the outputs as they stand now (6.4) and returns the
   * factUpdateMerge the fold applies.
   */
  async merge(request: FactMergeRequest): Promise<JsonObject> {
    if (request.runId !== this.runId) return emptyFactUpdateMerge(request.point);
    await this.loaded;
    await this.drain();
    this.assertHealthy();
    const point = request.point;
    let keys: string[];
    if (point === "chain") {
      keys = request.seat !== undefined ? [chainSubscriberKey(request.seat)] : [];
    } else if (point === "ideas" || point === "close") {
      keys = [...new Set([
        ...this.index.seats(this.runId).map((seat) => chainSubscriberKey(seat)),
        ...[...this.byKey.keys()].filter((key) => parseSubscriberKey(key)?.kind === "chain"),
      ])];
    } else {
      const kind = point === "game-reports" || point === "late-game-reports" ? "game-report" : "comment";
      if (request.seat === undefined || request.step === undefined || request.round === undefined) {
        return emptyFactUpdateMerge(point);
      }
      const round = `${kind}:${request.seat}:${request.step}:${request.round}`;
      keys = [...new Set([
        ...this.index.roundReports(this.runId, kind, request.seat, request.step, request.round).map((report) => report.key),
        ...[...this.byKey.keys()].filter((key) => key.startsWith(`${round}:`)),
      ])];
    }
    // Detection path 3 (design 3.4): outputs citing a deleted badge with no
    // task get one, and a task an earlier process left without a result is
    // run again on the output as it stands now (D10).
    await this.enqueue(() => this.ensure(keys));
    await this.drain();
    this.assertHealthy();
    const blocked = keys.filter((key) => this.blocked.has(key));
    if (blocked.length > 0 && this.windDown !== undefined) {
      throw new WindDownSignal(this.windDown.at, this.windDown.reason);
    }
    const merged: { readonly first: number; readonly entry: JsonObject }[] = [];
    const discarded: { readonly first: number; readonly entry: JsonObject }[] = [];
    for (const key of keys) {
      const parsed = parseSubscriberKey(key);
      if (parsed === undefined) continue;
      let task = this.liveTask(key);
      if (task !== undefined) await this.settled(task, request.signal);
      if (task !== undefined && parsed.kind === "chain" && task.outcome?.status === "ok") {
        // The base check (design 6.4, P7): a step or section the revision
        // rewrites that changed since the task began gets one re-run.
        const idea = this.index.idea(this.runId, parsed.seat);
        if (idea !== undefined && staleChainParts(idea, task.base, task.outcome.output).length > 0) {
          await this.enqueue(() => this.startAll([{ key, notices: task!.notices, rerun: true }]));
          await this.drain();
          this.assertHealthy();
          if (this.blocked.has(key) && this.windDown !== undefined) {
            throw new WindDownSignal(this.windDown.at, this.windDown.reason);
          }
          task = this.liveTask(key);
          if (task !== undefined) await this.settled(task, request.signal);
        }
      }
      for (const old of this.byKey.get(key) ?? []) {
        if (!old.superseded || old.listed || old.handed || this.index.isTaskConsumed(this.runId, old.taskId)) continue;
        old.listed = true;
        discarded.push({ first: this.firstSeq(old), entry: { key, taskId: old.taskId, notices: [...old.notices], reason: "superseded" } });
      }
      if (task === undefined) continue;
      const outcome = task.outcome;
      if (outcome === undefined) continue;
      if (outcome.status === "error") {
        // A thrown error (a credit block, a cancellation) propagates as it
        // is; a task that answered with an error fails the merge point.
        if (outcome.thrown !== undefined) throw outcome.thrown;
        throw new Error(`fact-update task ${task.taskId} failed: ${outcome.error}`);
      }
      task.handed = true;
      if (this.index.isDismissed(parsed.seat) || (parsed.critic !== undefined && this.index.isDismissed(parsed.critic))) {
        discarded.push({ first: this.firstSeq(task), entry: { key, taskId: task.taskId, notices: [...task.notices], reason: "seat-dismissed" } });
        continue;
      }
      if (parsed.kind !== "chain") {
        const report = this.index.report(this.runId, key);
        if (report === undefined || reportBase(report.report).report !== task.base.report) {
          discarded.push({ first: this.firstSeq(task), entry: { key, taskId: task.taskId, notices: [...task.notices], reason: "report-changed" } });
          continue;
        }
      }
      merged.push({
        first: this.firstSeq(task),
        entry: {
          key,
          taskId: task.taskId,
          notices: [...task.notices],
          output: outcome.output,
          ...(parsed.kind === "game-report" ? { epoch: task.epoch } : {}),
        },
      });
    }
    const order = (a: { readonly first: number; readonly entry: JsonObject }, b: { readonly first: number; readonly entry: JsonObject }) =>
      a.first - b.first || String(a.entry.key).localeCompare(String(b.entry.key));
    merged.sort(order);
    discarded.sort(order);
    const late = point === "late-game-reports" || point === "late-comments";
    if (late && request.seat !== undefined && request.step !== undefined && request.round !== undefined) {
      const kind = point === "late-game-reports" ? "game-report" : "comment";
      this.closedRounds.add(`${kind}:${request.seat}:${request.step}:${request.round}`);
    }
    if (point === "close") {
      this.closed = true;
      await this.append({ type: "closed", at: this.now() });
      this.assertHealthy();
    }
    return {
      merged: merged.map((item) => item.entry),
      discarded: discarded.map((item) => item.entry),
      ...(late ? {
        reassess: merged.some((item) => {
          const output = item.entry.output;
          return isObject(output) && (output.decision === "revised" || output.decision === "withdrawn");
        }),
      } : {}),
    };
  }

  /** Cancels every running task. */
  close(): void {
    this.controller.abort();
  }

  /**
   * Binds the running and future tasks to one run invocation's abort signal
   * (decision D16). When it aborts (the run was cancelled or ended failed),
   * every running task stops and journals an error result, and a task
   * journaled after it is not launched. Either runs again at its
   * subscriber's next merge point (D10), in a resumed process as in this one:
   * binding the next invocation forgets the errors no merge point took, as a
   * fresh load of the journal does.
   */
  bindRun(signal: AbortSignal): void {
    this.runSignal = signal;
    this.invocation += 1;
    for (const task of this.tasks.values()) {
      if (!task.handed && task.outcome?.status === "error") {
        task.outcome = undefined;
        task.run = undefined;
      }
    }
    const stop = (): void => {
      for (const task of this.tasks.values()) task.stop?.abort(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  }

  private submitterOf(event: FactUpdateEvent): FactUpdateSubmitter | undefined {
    const first = event.entry.requesters[0];
    if (first === undefined) return undefined;
    return {
      role: first.role,
      agent: first.agent,
      ...(first.seat !== undefined ? { seat: first.seat } : {}),
      ...(first.step !== undefined ? { step: first.step } : {}),
    };
  }

  private isRoundClosed(key: string): boolean {
    const parsed = parseSubscriberKey(key);
    if (parsed === undefined || parsed.kind === "chain") return false;
    return this.closedRounds.has(`${parsed.kind}:${parsed.seat}:${parsed.step}:${parsed.round}`) ||
      this.index.isRoundClosed(this.runId, key);
  }

  /** The task of `key` a merge still has to take: not superseded, not returned, not merged. */
  private liveTask(key: string): TaskState | undefined {
    const list = this.byKey.get(key) ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const task = list[index]!;
      if (task.superseded) continue;
      if (task.handed || this.index.isTaskConsumed(this.runId, task.taskId)) return undefined;
      return task;
    }
    return undefined;
  }

  private firstSeq(task: TaskState): number {
    return Math.min(...task.notices.map((id) => this.notices.get(id)?.seq ?? Number.MAX_SAFE_INTEGER));
  }

  /**
   * Starts the tasks a key needs (detection paths 2 and 3): the deleted
   * badges its output cites that no live task covers, and for a report none
   * a merge has taken already; a task an earlier process journaled without a
   * result is re-run (D10).
   */
  private async ensure(keys: readonly string[]): Promise<void> {
    await this.flushPending();
    if (this.closed) return;
    const known = [...this.notices.values()].sort((a, b) => a.seq - b.seq);
    const deletions = known.map((notice) => ({ id: notice.deleted, seq: notice.seq }));
    const starts: { key: string; notices: readonly string[]; rerun?: boolean }[] = [];
    for (const key of keys) {
      const parsed = parseSubscriberKey(key);
      if (parsed === undefined || this.isRoundClosed(key)) continue;
      const cited = this.index.citedBy(this.runId, key, deletions);
      const covered = new Set<string>();
      for (const task of this.byKey.get(key) ?? []) {
        if (task.superseded || this.index.isTaskConsumed(this.runId, task.taskId)) continue;
        for (const id of task.notices) covered.add(id);
      }
      if (parsed.kind !== "chain") {
        for (const id of this.index.consumedNotices(this.runId, key)) covered.add(id);
      }
      const missing = cited
        .map((deleted) => this.noticeByDeleted.get(deleted)!)
        .filter((notice) => !covered.has(notice.id))
        .map((notice) => notice.id);
      const live = this.liveTask(key);
      const orphan = live !== undefined && live.run === undefined && live.outcome === undefined;
      if (missing.length > 0 || orphan) starts.push({ key, notices: missing, ...(orphan ? { rerun: true } : {}) });
    }
    await this.startAll(starts);
  }

  /**
   * Journals the notice of every deletion the table recorded without one
   * (design 6.7). Its subscribers are found by the safety net that follows.
   */
  private async flushPending(): Promise<void> {
    const events = [...this.pending.values()].sort((a, b) => a.deletion.seq - b.deletion.seq);
    for (const event of events) {
      this.pending.delete(event.deletion.id);
      if (!this.noticeByDeleted.has(event.deletion.id)) await this.recordNotice(event, []);
    }
  }

  /**
   * Starts one task per key, all in the same tick (design 6.2): every task
   * line (and supersession) is journaled first, then every executor call is
   * made. A key's live task is superseded; the new task covers its notices
   * too (6.5).
   */
  private async startAll(starts: readonly { readonly key: string; readonly notices: readonly string[]; readonly rerun?: boolean }[]): Promise<void> {
    const ready: { readonly state: TaskState; readonly task: AgentTask }[] = [];
    for (const start of starts) {
      const previous = this.liveTask(start.key);
      if (start.notices.length === 0 && previous === undefined) continue;
      const notices = [...new Set([...(previous?.notices ?? []), ...start.notices])]
        .sort((a, b) => (this.notices.get(a)?.seq ?? 0) - (this.notices.get(b)?.seq ?? 0));
      if (this.windDown !== undefined && this.now() >= this.windDown.at) {
        this.blocked.add(start.key);
        continue;
      }
      if (previous !== undefined) {
        await this.append({ type: "supersede", keys: [start.key], taskIds: [previous.taskId], at: this.now() });
        previous.superseded = true;
      }
      const attempt = (this.attempts.get(start.key) ?? 0) + 1;
      this.attempts.set(start.key, attempt);
      const taskId = `fact-update:${start.key}:${attempt}`;
      const built = await this.build({ runId: this.runId, taskId, key: start.key, notices: notices.map((id) => this.noticeFor(id, start.key)) });
      const epoch = await this.table.deletionEpoch();
      await this.append({ type: "task", key: start.key, taskId, notices, epoch, base: built.base, at: this.now() });
      this.blocked.delete(start.key);
      const state: TaskState = { key: start.key, taskId, notices, epoch, base: built.base, superseded: false, handed: false, listed: false };
      this.remember(state);
      ready.push({ state, task: built.task });
    }
    // After the run invocation stopped (D16), a task is journaled but not
    // launched: it has no result, so its next merge point runs it (D10).
    if (this.runSignal?.aborted === true) return;
    for (const { state, task } of ready) state.run = this.execute(state, task);
  }

  /** One notice as a subscriber receives it: with the steps of its output that cite the deleted id (4.1). */
  private noticeFor(id: string, key: string): FactNotice {
    const notice = this.notices.get(id)!;
    const parsed = parseSubscriberKey(key);
    const chain = parsed?.kind === "chain"
      ? this.index.idea(this.runId, parsed.seat)?.cot
      : [...(this.index.report(this.runId, key)?.prefix ?? [])];
    const citedAt = citedSteps(chain as JsonValue | undefined, notice.deleted);
    return { ...notice.notice, ...(citedAt.length > 0 ? { citedAt } : {}) };
  }

  private async execute(state: TaskState, task: AgentTask): Promise<void> {
    // The task's token usage rides its result line (D8), as a verification's
    // rides its submission line.
    let usage: unknown;
    // The task stops when the spawner closes and when its run invocation
    // aborts (D16), whether or not the executor honours its signal.
    const stop = new AbortController();
    state.stop = stop;
    const invocation = this.invocation;
    const close = (): void => stop.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) close();
    else this.controller.signal.addEventListener("abort", close, { once: true });
    if (this.runSignal?.aborted === true) stop.abort(this.runSignal.reason);
    const stopped = new Promise<never>((_, reject) => {
      const onStop = (): void => reject(stop.signal.reason);
      if (stop.signal.aborted) onStop();
      else stop.signal.addEventListener("abort", onStop, { once: true });
    });
    stopped.catch(() => undefined);
    try {
      const call = this.executor.execute(task, {
        runId: this.runId,
        nodePath: `fact-updates/${state.key}`,
        signal: stop.signal,
      });
      call.catch(() => undefined);
      const result = await Promise.race([call, stopped]);
      usage = result.usage;
      if (result.status !== "ok") {
        state.outcome = { status: "error", error: result.error.message };
      } else {
        try {
          const output = validateArtifact(task.outputSchema?.name ?? "", FACT_UPDATE_NODE, result.output as JsonValue);
          state.outcome = { status: "ok", output: output as JsonObject };
        } catch (error) {
          state.outcome = { status: "error", error: messageOf(error) };
        }
      }
    } catch (error) {
      state.outcome = { status: "error", error: messageOf(error), thrown: error };
    } finally {
      this.controller.signal.removeEventListener("abort", close);
    }
    const outcome = state.outcome!;
    if (outcome.status === "error" && invocation !== this.invocation) {
      // Stopped by an earlier invocation that a later one has bound since:
      // the error is journaled, and the next merge point runs the task again.
      state.outcome = undefined;
      state.run = undefined;
    }
    await this.append({
      type: "result",
      taskId: state.taskId,
      status: outcome.status,
      ...(outcome.status === "ok" ? { output: outcome.output } : { error: outcome.error }),
      ...(usage !== undefined ? { usage } : {}),
      at: this.now(),
    }).catch(() => undefined);
  }

  private remember(state: TaskState): void {
    this.tasks.set(state.taskId, state);
    const list = this.byKey.get(state.key) ?? [];
    list.push(state);
    this.byKey.set(state.key, list);
  }

  /** Waits for a task to end; a cancelled merge stops waiting. */
  private async settled(task: TaskState, signal: AbortSignal): Promise<void> {
    if (task.run === undefined) return;
    if (signal.aborted) throw new WorkflowCancelledError();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new WorkflowCancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
      task.run!.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, reject);
    });
  }

  /** The notice of a deletion, composed by the host from the ruling (design 4.1) and journaled. */
  private async recordNotice(event: FactUpdateEvent, subscribers: readonly string[]): Promise<NoticeState> {
    const { deletion, entry, replacement } = event;
    const id = `N:${deletion.seq}`;
    const notice: FactNotice = {
      notice: id,
      deleted: deletion.id,
      claim: entry.claim,
      conditions: entry.conditions,
      reason: event.reason,
      ...(replacement !== undefined ? {
        replacement: {
          id: replacement.id,
          status: replacement.status,
          claim: replacement.claim,
          conditions: replacement.conditions,
          reason: factIssuanceReason(replacement),
        },
      } : {}),
    };
    await this.append({
      type: "notice",
      id,
      seq: deletion.seq,
      at: deletion.at,
      deleted: deletion.id,
      ...(deletion.replacedBy !== undefined ? { replacedBy: deletion.replacedBy } : {}),
      notice,
      subscribers: [...subscribers],
    });
    const state: NoticeState = { id, seq: deletion.seq, deleted: deletion.id, notice };
    this.notices.set(id, state);
    this.noticeByDeleted.set(deletion.id, state);
    return state;
  }

  /**
   * Loads the journal (design 6.7): notices, tasks, supersessions and results.
   * A task an earlier process ended with an error is run again at its next
   * merge point, as is one without a result. A deletion the table recorded
   * without a notice (a crash between the two) is kept for its notice, which
   * is journaled before subscribers are next looked for (see `pending`); its
   * subscribers are found by the merge points' safety net.
   */
  private async load(): Promise<void> {
    const text = await readFileIfExists(this.journalPath, DEFAULT_FS_DEADLINE_MS);
    if (text !== undefined && text.length > 0) {
      const lines = text.split("\n");
      // A last line without its newline is an unfinished write: ignored, and
      // fenced off before the next record.
      this.openLine = !text.endsWith("\n");
      for (const line of lines.slice(0, -1)) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (isObject(record)) this.replay(record);
      }
    }
    for (const event of await this.table.updateEvents()) {
      if (!this.noticeByDeleted.has(event.deletion.id)) this.pending.set(event.deletion.id, event);
    }
  }

  private replay(record: JsonObject): void {
    if (record.type === "notice" && typeof record.id === "string" && typeof record.seq === "number" &&
        typeof record.deleted === "string" && isObject(record.notice)) {
      const state: NoticeState = { id: record.id, seq: record.seq, deleted: record.deleted, notice: record.notice as unknown as FactNotice };
      this.notices.set(state.id, state);
      this.noticeByDeleted.set(state.deleted, state);
    } else if (record.type === "task" && typeof record.key === "string" && typeof record.taskId === "string" &&
        Array.isArray(record.notices) && typeof record.epoch === "number" && isObject(record.base)) {
      const attempt = Number(record.taskId.slice(record.taskId.lastIndexOf(":") + 1));
      if (Number.isSafeInteger(attempt)) this.attempts.set(record.key, Math.max(this.attempts.get(record.key) ?? 0, attempt));
      this.remember({
        key: record.key,
        taskId: record.taskId,
        notices: record.notices.filter((id): id is string => typeof id === "string"),
        epoch: record.epoch,
        base: record.base,
        superseded: false,
        handed: false,
        listed: false,
      });
    } else if (record.type === "supersede" && Array.isArray(record.taskIds)) {
      for (const taskId of record.taskIds) {
        const task = typeof taskId === "string" ? this.tasks.get(taskId) : undefined;
        if (task !== undefined) task.superseded = true;
      }
    } else if (record.type === "result" && typeof record.taskId === "string") {
      const task = this.tasks.get(record.taskId);
      if (task !== undefined && record.status === "ok" && isObject(record.output)) {
        task.outcome = { status: "ok", output: record.output };
      }
    } else if (record.type === "closed") {
      this.closed = true;
    }
  }

  /** Bookkeeping runs one step at a time; a failed step fails the next merge point. */
  private enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      await this.loaded;
      await step();
    });
    this.queue = next.catch((error: unknown) => {
      this.failure ??= error;
    });
    return this.queue;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const current = this.queue;
      await current;
      if (current === this.queue) return;
    }
  }

  private assertHealthy(): void {
    if (this.persistenceError !== undefined) {
      throw new Error(`the fact-update journal could not be written: ${messageOf(this.persistenceError)}`);
    }
    if (this.failure !== undefined) throw this.failure;
  }

  /**
   * Appends one record as one durable line behind every earlier one. A failed
   * write stops the spawner: every later append and the next merge point fail
   * (design 6.1).
   */
  private append(record: object): Promise<void> {
    const written = this.writes.then(async () => {
      if (this.persistenceError !== undefined) throw this.persistenceError;
      try {
        if (!this.directoryReady) {
          await withFsDeadline(mkdir(dirname(this.journalPath), { recursive: true }), DEFAULT_FS_DEADLINE_MS,
            `creating the directory of ${this.journalPath}`);
          this.directoryReady = true;
        }
        const prefix = this.openLine ? "!\n" : "";
        await withFsDeadline(appendFile(this.journalPath, `${prefix}${JSON.stringify(record)}\n`, "utf8"),
          DEFAULT_FS_DEADLINE_MS, `appending to ${this.journalPath}`);
        this.openLine = false;
      } catch (error) {
        this.openLine = true;
        this.persistenceError = error;
        throw error;
      }
    });
    this.writes = written.then(() => undefined, () => undefined);
    return written;
  }
}
