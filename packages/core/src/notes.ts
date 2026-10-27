/**
 * The thinker's working notes, as the review tools read them.
 *
 * Every chain-writing task (a seat's first pass, each of its
 * redevelopments) leaves its recorded thinking in a per-task artifact — the
 * full trace, never cut. Review tasks used to receive a per-step slice of it
 * bound into their prompt; the slice was capped at 20,000 characters per
 * step, and in practice a thinker does most of its thinking before it
 * submits step 1, so the "notes behind step k" were both truncated and
 * misattributed. The notes now stay out of the prompt and are reached
 * through a search tool instead (host-tools: notes_search).
 *
 * This module is the contract between the three parties:
 * - the worker, which owns the artifacts and implements NotesAccess by
 *   collecting one seat's traces;
 * - the runtime, which stamps each review task with the NotesScope it may
 *   read (the seat under review, and how far along the chain it is);
 * - the tool, which searches the traces inside that scope.
 */

/** One recorded thinking segment: the provider streamed it in turn `turn`. */
export interface NoteSegment {
  readonly turn: number;
  readonly text: string;
}

/** The turn in which the task submitted chain step `index` (1-based). */
export interface NoteStepTurn {
  readonly index: number;
  readonly turn: number;
}

/** One task's complete recorded thinking, with the steps it wrote. */
export interface NoteTrace {
  /**
   * "first-pass": the seat's original chain. "redevelopment": one repair
   * round; `rewrote` lists the steps that round rewrote.
   */
  readonly kind: "first-pass" | "redevelopment";
  /** Position in the seat's history: the first pass is 0, repairs count up. */
  readonly order: number;
  readonly segments: readonly NoteSegment[];
  readonly stepTurns: readonly NoteStepTurn[];
  readonly rewrote?: readonly number[];
}

/** What one review task may read: one seat's notes, up to one chain position. */
export interface NotesScope {
  /** The seat (panel member id) whose chain is under review. */
  readonly seat: string;
  /**
   * The chain position under review (1-based). Thinking recorded after a
   * trace submitted this step belongs to steps the reviewer has not been
   * shown and stays hidden.
   */
  readonly throughStep: number;
}

/** Supplies a seat's traces; the worker implements it over the run's artifacts. */
export interface NotesAccess {
  traces(scope: NotesScope, signal?: AbortSignal): Promise<readonly NoteTrace[]>;
}

/** Where a task's `metadata.notesScope` is read from, when it carries one. */
export function notesScopeOf(metadata: unknown): NotesScope | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const raw = (metadata as { notesScope?: unknown }).notesScope;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { seat, throughStep } = raw as { seat?: unknown; throughStep?: unknown };
  return typeof seat === "string" &&
    seat !== "" &&
    typeof throughStep === "number" &&
    Number.isSafeInteger(throughStep) &&
    throughStep >= 1
    ? { seat, throughStep }
    : undefined;
}

/**
 * The per-task scopes of the tasks currently executing, keyed by task id.
 * A run-global tool (the Messages path registers tools once per run) finds
 * its caller's scope here; the worker's executor wrapper records a task's
 * scope before the task runs and clears it after.
 */
export class NotesScopeRegistry {
  private readonly scopes = new Map<string, NotesScope>();

  enter(taskId: string, scope: NotesScope): void {
    this.scopes.set(taskId, scope);
  }

  leave(taskId: string): void {
    this.scopes.delete(taskId);
  }

  get(taskId: string | undefined): NotesScope | undefined {
    return taskId === undefined ? undefined : this.scopes.get(taskId);
  }
}
