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
 *
 * Writes are also DEADLINE-BOUNDED and asynchronous. These stores live on
 * shared filesystems (Lustre/NFS on the SLURM deployments), where one write
 * can block IN THE KERNEL when the mount wedges — a synchronous write then
 * freezes the whole Node event loop: no events, no timers, no signal
 * handlers, a process that answers liveness probes forever while doing
 * nothing (observed in production as a run "running" silently for hours).
 * An async write that misses its deadline REJECTS instead: the checkpoint
 * retry ladder absorbs a transient blip, and a persistent one fails the run
 * loudly — a failed or dead worker is a state the server already detects
 * and resumes, a frozen one is not.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Default ceiling for one filesystem operation; generous for a busy mount. */
export const DEFAULT_FS_DEADLINE_MS = 120_000;

/** The filesystem operations the stores perform, injectable for tests. */
export interface StoreFs {
  mkdir(path: string, options: { readonly recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const REAL_FS: StoreFs = { mkdir, writeFile, rename, readFile };

export interface FsStoreOptions {
  /** Ceiling for one filesystem operation, in ms. 0 disables the deadline. */
  readonly deadlineMs?: number;
  /** Test seam. */
  readonly fs?: StoreFs;
}

/**
 * Awaits one filesystem operation for at most `deadlineMs`. On expiry the
 * operation is ABANDONED (its promise is silenced so a late settlement never
 * surfaces as an unhandled rejection) and the caller gets a rejection that
 * names the unresponsive filesystem — an actionable failure instead of a
 * silent forever-hang.
 */
export async function withFsDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  if (deadlineMs <= 0) return work;
  void work.then(undefined, () => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} did not finish within ${Math.round(deadlineMs / 1000)}s — ` +
                  "the filesystem is not responding",
              ),
            ),
          deadlineMs,
        );
        // REFERENCED deliberately (the executor stall watchdog learned the
        // same lesson): a write blocked in the kernel holds no live handle,
        // so an unref'd deadline let the event loop drain mid-race and the
        // process exit silently — the exact silent death this bound exists
        // to prevent. The finally below clears the timer the moment the
        // race settles, so it never outlives a healthy operation.
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deadline-bounded read that treats a missing file as undefined. Existence
 * is answered by the read itself rather than a separate existsSync — a stat
 * on a wedged mount blocks in the kernel exactly like a read, so the sync
 * probe would reintroduce the freeze the deadline exists to prevent.
 */
export async function readFileIfExists(
  path: string,
  deadlineMs: number = DEFAULT_FS_DEADLINE_MS,
  fs: StoreFs = REAL_FS,
): Promise<string | undefined> {
  try {
    return await withFsDeadline(
      fs.readFile(path, "utf8"),
      deadlineMs,
      `reading ${path}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Crash-safe, deadline-bounded write: temp file, then atomic rename. */
export async function atomicWriteFile(
  path: string,
  data: string,
  deadlineMs: number = DEFAULT_FS_DEADLINE_MS,
  fs: StoreFs = REAL_FS,
): Promise<void> {
  await withFsDeadline(
    fs.mkdir(dirname(path), { recursive: true }),
    deadlineMs,
    `creating the directory of ${path}`,
  );
  const tmp = `${path}.tmp-${process.pid}`;
  await withFsDeadline(
    fs.writeFile(tmp, data, "utf8"),
    deadlineMs,
    `writing ${path}`,
  );
  await withFsDeadline(fs.rename(tmp, path), deadlineMs, `replacing ${path}`);
}

/** Serialized checkpoint size above which every save logs a loud warning. */
const CHECKPOINT_WARN_BYTES = 128 * 1024 * 1024;

export class FsCheckpointStore implements CheckpointStore {
  /** Runs already warned about, so the log carries one line per run. */
  private readonly warnedRunIds = new Set<string>();
  private readonly deadlineMs: number;
  private readonly fs: StoreFs;

  constructor(
    private readonly sessionRoot: string,
    options: FsStoreOptions = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? DEFAULT_FS_DEADLINE_MS;
    this.fs = options.fs ?? REAL_FS;
  }

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
    await atomicWriteFile(this.file(checkpoint.runId), data, this.deadlineMs, this.fs);
  }

  async load(runId: string): Promise<WorkflowCheckpoint | undefined> {
    const raw = await readFileIfExists(this.file(runId), this.deadlineMs, this.fs);
    return raw === undefined ? undefined : (JSON.parse(raw) as WorkflowCheckpoint);
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
  private readonly deadlineMs: number;
  private readonly fs: StoreFs;
  /**
   * Serializes every put(). The synchronous store was atomic for free — a
   * whole read-modify-write of the index ran without yielding the event
   * loop — but the async writes let two parallel branches interleave: both
   * read counter N, both mint artifact-(N+1), and the second rename fails
   * on the first one's already-consumed temp file (or silently drops the
   * other's ref). Reads stay unlocked: index writes land by atomic rename,
   * so a reader sees the old or the new index, never a torn one.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(sessionRoot: string, runId: string, options: FsStoreOptions = {}) {
    this.dir = join(sessionRoot, runId, "artifacts");
    this.deadlineMs = options.deadlineMs ?? DEFAULT_FS_DEADLINE_MS;
    this.fs = options.fs ?? REAL_FS;
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private indexFile(): string {
    return join(this.dir, "index.json");
  }

  private async readIndex(): Promise<ArtifactIndex> {
    const raw = await readFileIfExists(this.indexFile(), this.deadlineMs, this.fs);
    return raw === undefined
      ? { counter: 0, refs: [] }
      : (JSON.parse(raw) as ArtifactIndex);
  }

  private write(path: string, data: string): Promise<void> {
    return atomicWriteFile(path, data, this.deadlineMs, this.fs);
  }

  /**
   * Idempotent on (name, payload hash): a resumed run re-executes its state
   * folds, which re-persist the exact same artifacts — the existing ref is
   * returned instead of appending a duplicate, so the ref history the run
   * state rebuilds matches the original run's byte for byte. Refs written
   * before hashes existed are backfilled from their files on first touch.
   */
  put(artifact: ArtifactInput): Promise<ArtifactRef> {
    return this.locked(() => this.putLocked(artifact));
  }

  private async putLocked(artifact: ArtifactInput): Promise<ArtifactRef> {
    const sha256 = artifactSha256(artifact.data);
    const index = await this.readIndex();
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
        if (backfilled) {
          await this.write(this.indexFile(), JSON.stringify(index, null, 2));
        }
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
    await this.write(join(this.dir, id), artifact.data);
    index.refs.push(ref);
    await this.write(this.indexFile(), JSON.stringify(index, null, 2));
    return ref;
  }

  async get(id: string): Promise<StoredArtifact | undefined> {
    const ref = (await this.readIndex()).refs.find((candidate) => candidate.id === id);
    if (!ref) return undefined;
    const data = await readFileIfExists(join(this.dir, id), this.deadlineMs, this.fs);
    return data === undefined ? undefined : { ...ref, data };
  }

  async list(): Promise<readonly ArtifactRef[]> {
    return (await this.readIndex()).refs;
  }
}
