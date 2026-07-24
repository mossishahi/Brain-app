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

export class FsCheckpointStore implements CheckpointStore {
  constructor(private readonly sessionRoot: string) {}

  private file(runId: string): string {
    return join(this.sessionRoot, runId, "checkpoint.json");
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    atomicWrite(this.file(checkpoint.runId), JSON.stringify(checkpoint, null, 2));
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

  async put(artifact: ArtifactInput): Promise<ArtifactRef> {
    const index = this.readIndex();
    index.counter += 1;
    const id = `artifact-${index.counter}`;
    const ref: ArtifactRef = {
      id,
      name: artifact.name,
      size: artifact.data.length,
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
