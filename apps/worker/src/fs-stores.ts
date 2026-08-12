/**
 * File-backed checkpoint and artifact stores.
 *
 * Layout, one directory per run:
 *   <sessionRoot>/<runId>/
 *     checkpoint.json          the full workflow checkpoint (journal included)
 *     artifacts/index.json     artifact refs
 *     artifacts/<id>           artifact payloads
 *
 * Writes are crash-safe: temp file in the same directory, then atomic rename.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { artifactSha256 } from "@brainstorm-agentic/core";
import type {
  ArtifactInput,
  ArtifactRef,
  ArtifactStore,
  CheckpointStore,
  StoredArtifact,
  WorkflowCheckpoint,
} from "@brainstorm-agentic/core";

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

/** Serialized checkpoint size above which every save logs a loud warning. */
const CHECKPOINT_WARN_BYTES = 128 * 1024 * 1024;

export class FsCheckpointStore implements CheckpointStore {
  /** Runs already warned about, so the log carries one line per run. */
  private readonly warnedRunIds = new Set<string>();

  constructor(private readonly sessionRoot: string) {}

  private file(runId: string): string {
    return join(this.sessionRoot, runId, "checkpoint.json");
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    // Compact on purpose: pretty-printing roughly doubled the file, and a
    // checkpoint that outgrows the engine's maximum string length cannot be
    // serialized at all ("Invalid string length") — which kills the very
    // save that should have recorded the run's state.
    const data = JSON.stringify(checkpoint);
    if (data.length > CHECKPOINT_WARN_BYTES && !this.warnedRunIds.has(checkpoint.runId)) {
      this.warnedRunIds.add(checkpoint.runId);
      console.error(
        `[checkpoint] run ${checkpoint.runId} serializes to ${Math.round(data.length / (1024 * 1024))} MB — ` +
          "approaching the engine's string limit; the journal is growing too fast",
      );
    }
    atomicWrite(this.file(checkpoint.runId), data);
  }

  async load(runId: string): Promise<WorkflowCheckpoint | undefined> {
    const file = this.file(runId);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as WorkflowCheckpoint;
  }

  async delete(runId: string): Promise<void> {
    const dir = join(this.sessionRoot, runId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  listRunIds(): string[] {
    if (!existsSync(this.sessionRoot)) return [];
    return readdirSync(this.sessionRoot)
      .filter((entry) => existsSync(this.file(entry)))
      .sort();
  }
}

interface ArtifactIndex {
  counter: number;
  refs: ArtifactRef[];
}

export class FsArtifactStore implements ArtifactStore {
  private readonly dir: string;

  constructor(sessionRoot: string, runId: string) {
    this.dir = join(sessionRoot, runId, "artifacts");
  }

  private indexFile(): string {
    return join(this.dir, "index.json");
  }

  private readIndex(): ArtifactIndex {
    if (!existsSync(this.indexFile())) return { counter: 0, refs: [] };
    return JSON.parse(readFileSync(this.indexFile(), "utf8")) as ArtifactIndex;
  }

  /**
   * Idempotent on (name, payload hash): a resumed run re-executes its state
   * folds, which re-persist the exact same artifacts — the existing ref is
   * returned instead of appending a duplicate, so the ref history the run
   * state rebuilds matches the original run's byte for byte. Refs written
   * before hashes existed are backfilled from their files on first touch.
   */
  async put(artifact: ArtifactInput): Promise<ArtifactRef> {
    const sha256 = artifactSha256(artifact.data);
    const index = this.readIndex();
    let backfilled = false;
    for (let position = 0; position < index.refs.length; position += 1) {
      const ref = index.refs[position]!;
      if (ref.name !== artifact.name) continue;
      let known: string | undefined = ref.sha256;
      if (known === undefined) {
        try {
          known = artifactSha256(readFileSync(join(this.dir, ref.id), "utf8"));
          index.refs[position] = { ...ref, sha256: known };
          backfilled = true;
        } catch {
          continue; // a ref whose payload vanished cannot dedupe anything
        }
      }
      if (known === sha256) {
        if (backfilled) atomicWrite(this.indexFile(), JSON.stringify(index, null, 2));
        return index.refs[position]!;
      }
    }
    index.counter += 1;
    const id = `artifact-${index.counter}`;
    const ref: ArtifactRef = {
      id,
      name: artifact.name,
      size: artifact.data.length,
      sha256,
      ...(artifact.contentType !== undefined ? { contentType: artifact.contentType } : {}),
      ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
    };
    atomicWrite(join(this.dir, id), artifact.data);
    index.refs.push(ref);
    atomicWrite(this.indexFile(), JSON.stringify(index, null, 2));
    return ref;
  }

  async get(id: string): Promise<StoredArtifact | undefined> {
    const ref = this.readIndex().refs.find((candidate) => candidate.id === id);
    const file = join(this.dir, id);
    if (!ref || !existsSync(file)) return undefined;
    return { ...ref, data: readFileSync(file, "utf8") };
  }

  async list(): Promise<readonly ArtifactRef[]> {
    return this.readIndex().refs;
  }
}
