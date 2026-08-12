/**
 * Format-1 → format-2 journal migration.
 *
 * Format-1 journals (every pre-fold release) recorded a FULL copy of the run
 * state for every state-writing activity — the layout whose growth crossed
 * the engine's maximum string length on real runs. Format 2 journals only
 * real outputs and recomputes the deterministic folds on replay.
 *
 * Migration maps an old journal onto exactly what a format-2 run would have
 * recorded, using the run's own pinned workflow as the node table:
 *
 * - agent results, gate answers, condition verdicts, collections: KEPT as-is;
 * - a content activity's entry (value = post-apply state): SHRUNK to the
 *   node's declared output (`state[output.key]`) and re-keyed onto the
 *   `<id>-run` child node the format-2 compiler emits;
 * - fold entries (`-store`, `-phase`, round bookkeeping, branch snapshots,
 *   merges, gate applies): DROPPED — replay recomputes them.
 *
 * The mapping happens in memory on load; the first save after a successful
 * resume persists format 2. Never migrate backward.
 */
import type {
  WorkflowDefinition as ContentWorkflowDefinition,
  WorkflowNode as ContentWorkflowNode,
} from "@brainstorm-agentic/content";
import {
  JOURNAL_FORMAT,
  type CheckpointStore,
  type JournalEntry,
  type JsonObject,
  type WorkflowCheckpoint,
} from "@brainstorm-agentic/core";

interface MigrationTables {
  /** Content activity node id -> its declared output key (a state field). */
  readonly activityOutputKey: ReadonlyMap<string, string>;
  /** Leaf node ids whose format-1 entries are fold state copies to drop. */
  readonly foldLeaves: ReadonlySet<string>;
}

function collectTables(content: ContentWorkflowDefinition): MigrationTables {
  const activityOutputKey = new Map<string, string>();
  const foldLeaves = new Set<string>();
  const walk = (node: ContentWorkflowNode): void => {
    switch (node.kind) {
      case "sequence":
        for (const step of node.steps) walk(step);
        return;
      case "activity":
        activityOutputKey.set(node.id, node.output.key);
        return;
      case "agent":
        foldLeaves.add(`${node.id}-store`);
        foldLeaves.add(`${node.id}-phase`);
        return;
      case "forEach":
        if (node.mode === "parallel") {
          foldLeaves.add(`${node.id}-snapshot`);
          foldLeaves.add(`${node.id}-merge`);
        }
        walk(node.body);
        return;
      case "repeatUntil":
        foldLeaves.add(`${node.id}-initialize`);
        foldLeaves.add(`${node.id}-prepare`);
        foldLeaves.add(`${node.id}-finish`);
        walk(node.body);
        return;
      case "condition":
        walk(node.then);
        if (node.else) walk(node.else);
        return;
      case "humanGate":
        // The `${id}-auto` decision entry stays (it IS the recorded answer);
        // only the state-writing apply is a fold.
        foldLeaves.add(`${node.id}-apply`);
        return;
      case "terminal":
        return;
    }
  };
  walk(content.root);
  return { activityOutputKey, foldLeaves };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Migrates one checkpoint's journal to the current format. Checkpoints
 * already at (or past) the current format are returned unchanged. An old
 * content-activity entry whose output cannot be extracted is dropped —
 * replay then re-runs the deterministic handler instead of failing the run.
 */
export function migrateCheckpointJournal(
  checkpoint: WorkflowCheckpoint,
  content: ContentWorkflowDefinition,
): WorkflowCheckpoint {
  if ((checkpoint.journalFormat ?? 1) >= JOURNAL_FORMAT) return checkpoint;
  const tables = collectTables(content);
  const journal: JournalEntry[] = [];
  for (const entry of checkpoint.journal) {
    const separator = entry.key.lastIndexOf("::");
    const path = separator >= 0 ? entry.key.slice(0, separator) : entry.key;
    const slot = separator >= 0 ? entry.key.slice(separator + 2) : "";
    const leaf = path.split("/").pop() ?? "";
    if (entry.kind === "activity" && slot === "result") {
      if (tables.foldLeaves.has(leaf)) continue;
      const outputKey = tables.activityOutputKey.get(leaf);
      if (outputKey !== undefined) {
        const output = isObject(entry.value) ? entry.value[outputKey] : undefined;
        if (output === undefined) continue;
        journal.push({
          key: `${path}/${leaf}-run::result`,
          kind: "activity",
          value: output,
        });
        continue;
      }
    }
    journal.push(entry);
  }
  return { ...checkpoint, journalFormat: JOURNAL_FORMAT, journal };
}

/**
 * A checkpoint store whose loads migrate old journals forward in memory.
 * Saves pass through untouched (the runner stamps the current format), so
 * nothing on disk changes until the resumed run records its first effect.
 */
export class MigratingCheckpointStore implements CheckpointStore {
  constructor(
    private readonly inner: CheckpointStore,
    private readonly content: ContentWorkflowDefinition,
  ) {}

  save(checkpoint: WorkflowCheckpoint): Promise<void> {
    return this.inner.save(checkpoint);
  }

  async load(runId: string): Promise<WorkflowCheckpoint | undefined> {
    const checkpoint = await this.inner.load(runId);
    return checkpoint ? migrateCheckpointJournal(checkpoint, this.content) : undefined;
  }

  delete(runId: string): Promise<void> {
    return this.inner.delete(runId);
  }
}
