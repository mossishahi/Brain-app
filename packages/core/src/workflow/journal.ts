/**
 * Effect journal. Every side effect and control decision (activity result,
 * agent result, condition outcome, resolved collection, selector value, human
 * gate response) is recorded under a deterministic key derived from the
 * node's execution path. Resuming a run replays the AST: journal hits return
 * the recorded value instead of re-executing, so control flow reconstructs
 * itself deterministically without persisting interpreter state.
 */
import type { JsonValue } from "../types/json.js";

export type JournalEntryKind =
  | "activity"
  | "agent"
  | "condition"
  | "items"
  | "selector"
  | "gate";

export interface JournalEntry {
  readonly key: string;
  readonly kind: JournalEntryKind;
  /** Absent property means the recorded result was `undefined`. */
  readonly value?: JsonValue;
}

export interface JournalLookup {
  readonly hit: boolean;
  readonly value?: JsonValue;
}

export class RunJournal {
  private readonly entries = new Map<string, JournalEntry>();

  static fromEntries(entries: readonly JournalEntry[]): RunJournal {
    const journal = new RunJournal();
    for (const entry of entries) journal.entries.set(entry.key, entry);
    return journal;
  }

  lookup(key: string): JournalLookup {
    const entry = this.entries.get(key);
    if (!entry) return { hit: false };
    return "value" in entry ? { hit: true, value: entry.value } : { hit: true };
  }

  record(entry: JournalEntry): void {
    this.entries.set(entry.key, entry);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  toEntries(): readonly JournalEntry[] {
    return [...this.entries.values()];
  }

  /** All entries of a given kind, e.g. to aggregate agent usage. */
  byKind(kind: JournalEntryKind): readonly JournalEntry[] {
    return this.toEntries().filter((entry) => entry.kind === kind);
  }
}
