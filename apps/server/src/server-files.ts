/**
 * Read-only browser over the orchestration server's filesystem.
 *
 * The configured roots are STARTING POINTS (quick-access bookmarks), not a
 * security boundary: research inputs routinely live outside the workspace or
 * home directory (HPC scratch/project mounts, symlinked storage), so any
 * absolute path the server process can read may be browsed, validated, and
 * attached. The operating-system permissions of the server user are the
 * boundary. This stays deliberately metadata-only: the webapp can list names
 * and validate a selection, but cannot download file contents. Content is
 * snapshotted by JobManager at launch and exposed only to scoped model tools.
 *
 * THE ONE RULE OF THIS MODULE: never block the event loop, never run without
 * a bound. The first version walked directories with readdirSync/statSync,
 * and one search over a slow shared filesystem froze the WHOLE server for
 * minutes — no request was answered (including the "Validate & attach" the
 * user pressed next), the SSE streams died, the browser tab could not even
 * reload (the server serves the webapp too), and `scancel` left the job in
 * CG because a blocked event loop never runs the SIGTERM handler. Every
 * filesystem call here is therefore asynchronous (the loop stays free and
 * signals are always handled), every walk carries a TIME BUDGET and answers
 * with partial results (`truncated`) instead of hanging, and every walk stops
 * when its request's AbortSignal fires — a closed picker costs nothing.
 * Walks also run a few operations in parallel: a network filesystem is slow
 * per call, not in total, so bounded concurrency is what makes search quick.
 */
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import yauzl, { type Entry } from "yauzl";
import {
  ATTACHMENT_LIMITS,
  type AttachmentSelectionKind,
  type BrowseServerFilesResponse,
  type SearchServerFilesResponse,
  type ServerAttachmentRoot,
  type ServerFileEntry,
  type ValidatedAttachment,
} from "@brainstorm-agentic/protocol";

import {
  inspectWebAttachment,
  safeArchiveRelativePath,
} from "./attachments.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".tif",
  ".tiff",
]);
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".wmv",
]);
const JUNK_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  ".next",
  ".cache",
]);
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db"]);

export class ServerFileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerFileError";
  }
}

/**
 * Every ceiling one explorer request may spend, in one place so tests can
 * shrink them and a deployment could tune them. The deadlines are the
 * load-bearing part: a walk that cannot finish in time answers with what it
 * found (`truncated`) — the server never owes a slow filesystem more than a
 * few seconds of one request's patience, and never any of its event loop.
 */
export interface ServerFileBrowserLimits {
  /** Parallel filesystem operations per walk. */
  readonly concurrency: number;
  readonly searchDeadlineMs: number;
  readonly searchMaxDirectories: number;
  readonly searchMaxResults: number;
  readonly searchMaxDepth: number;
  readonly browseDeadlineMs: number;
  readonly browseMaxEntries: number;
  /** Folder-inventory budget for validate(); exceeding it FAILS the path. */
  readonly validateDeadlineMs: number;
}

export const DEFAULT_SERVER_FILE_LIMITS: ServerFileBrowserLimits = {
  concurrency: 8,
  searchDeadlineMs: 3_500,
  searchMaxDirectories: 2_000,
  searchMaxResults: 100,
  searchMaxDepth: 8,
  browseDeadlineMs: 8_000,
  browseMaxEntries: 1_500,
  validateDeadlineMs: 45_000,
};

/** What bounds one walk: the wall-clock budget and the request's own signal. */
interface WalkBounds {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal | undefined;
}

function outOfTime(bounds: WalkBounds): boolean {
  return bounds.signal?.aborted === true || Date.now() >= bounds.deadlineAt;
}

/**
 * Drains a self-growing queue with bounded parallelism. Workers may push new
 * items while running (a directory walk enqueues subdirectories). The first
 * worker error stops the pump and propagates — expected filesystem errors
 * (vanished entries, permission refusals) are the WORKER's to swallow, so
 * anything that reaches here is a real defect and must fail loud.
 */
async function pumpQueue<T>(
  queue: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let active = 0;
  let failure: unknown;
  await new Promise<void>((resolvePump) => {
    const next = (): void => {
      if (failure !== undefined || (queue.length === 0 && active === 0)) {
        if (active === 0) resolvePump();
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const item = queue.shift()!;
        active += 1;
        void worker(item)
          .catch((error: unknown) => {
            failure ??= error;
          })
          .finally(() => {
            active -= 1;
            next();
          });
      }
    };
    next();
  });
  if (failure !== undefined) throw failure;
}

async function readable(path: string, directory: boolean): Promise<boolean> {
  try {
    await access(
      path,
      directory ? constants.R_OK | constants.X_OK : constants.R_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function typeMatch(
  kind: AttachmentSelectionKind,
  path: string,
  directory: boolean,
): { selectable: boolean; reason?: string } {
  if (kind === "web") return { selectable: false, reason: "Use the URL field." };
  if (directory) {
    return kind === "folder"
      ? { selectable: true }
      : { selectable: false, reason: "Open this folder to choose files." };
  }
  if (kind === "folder") {
    return { selectable: false, reason: "Choose a folder, not a file." };
  }
  const ext = extname(path).toLowerCase();
  const accepted =
    kind === "file" ||
    (kind === "zip" && ext === ".zip") ||
    (kind === "pdf" && ext === ".pdf") ||
    (kind === "image" && IMAGE_EXTENSIONS.has(ext)) ||
    (kind === "video" && VIDEO_EXTENSIONS.has(ext));
  return accepted
    ? { selectable: true }
    : { selectable: false, reason: `Not a ${kind} attachment.` };
}

/**
 * One directory child, classified from its dirent with as few extra calls as
 * possible: a plain entry needs no call at all to learn its type (the dirent
 * carries it), and only a symlink pays for realpath + stat. The old code paid
 * realpath + stat for EVERY child, which multiplied a network filesystem's
 * per-call latency by the whole tree.
 */
interface ClassifiedChild {
  readonly name: string;
  /** Canonical for symlinks, plain join for ordinary entries. */
  readonly path: string;
  readonly isDirectory: boolean;
  /** Present when classification already had to stat (symlinks). */
  readonly stats?: Stats;
}

async function classifyChild(
  parent: string,
  child: Dirent,
): Promise<ClassifiedChild | undefined> {
  if (child.isSymbolicLink()) {
    // Symlinks are followed wherever they lead: on HPC hosts the useful
    // storage ($HOME/scratch -> /scratch/user) usually lives outside the
    // starting root. A dangling link is skipped.
    try {
      const path = await realpath(join(parent, child.name));
      const stats = await stat(path);
      if (!stats.isDirectory() && !stats.isFile()) return undefined;
      return { name: child.name, path, isDirectory: stats.isDirectory(), stats };
    } catch {
      return undefined;
    }
  }
  if (child.isDirectory()) {
    return { name: child.name, path: join(parent, child.name), isDirectory: true };
  }
  if (child.isFile()) {
    return { name: child.name, path: join(parent, child.name), isDirectory: false };
  }
  return undefined;
}

function skipChildName(name: string): boolean {
  // The picker is for scientific inputs, not repository internals or
  // operating-system metadata. These entries are also skipped by the
  // snapshotter, so hiding them here keeps browse and ingestion aligned.
  return (
    name.startsWith(".") || JUNK_DIRECTORIES.has(name) || JUNK_FILES.has(name)
  );
}

function sortEntries(entries: ServerFileEntry[]): void {
  entries.sort(
    (left, right) =>
      (left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === "folder"
          ? -1
          : 1),
  );
}

interface InventoryCount {
  files: number;
  bytes: number;
}

/**
 * Counts every ingestible file of a folder the user wants to attach.
 * Asynchronous and bounded like every walk here — but validation must be
 * COMPLETE to mean anything, so running out of time fails the folder with a
 * clear reason instead of returning a partial count that would under-report
 * what ingestion is about to copy.
 */
async function inspectTree(
  root: string,
  concurrency: number,
  bounds: WalkBounds,
): Promise<InventoryCount> {
  const count: InventoryCount = { files: 0, bytes: 0 };
  const queue: string[] = [root];
  let expired = false;
  await pumpQueue(queue, concurrency, async (directory) => {
    if (expired) return;
    if (outOfTime(bounds)) {
      expired = true;
      queue.length = 0;
      return;
    }
    const children = await readdir(directory, { withFileTypes: true });
    for (const entry of children) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!JUNK_DIRECTORIES.has(entry.name)) queue.push(path);
        continue;
      }
      if (!entry.isFile() || JUNK_FILES.has(entry.name)) continue;
      if (!(await readable(path, false))) {
        throw new Error(`"${path}" is not readable`);
      }
      const bytes = (await stat(path)).size;
      if (bytes > ATTACHMENT_LIMITS.maxFileBytes) {
        throw new Error(`"${path}" exceeds the per-file size limit`);
      }
      count.files += 1;
      count.bytes += bytes;
      if (count.files > ATTACHMENT_LIMITS.maxFiles) {
        throw new Error(
          `folder exceeds the ${ATTACHMENT_LIMITS.maxFiles}-file limit`,
        );
      }
      if (count.bytes > ATTACHMENT_LIMITS.maxTotalBytes) {
        throw new Error("folder exceeds the total attachment size limit");
      }
    }
  });
  if (expired) {
    throw new Error(
      "the folder inventory did not finish in time — the storage answered " +
        "too slowly or the folder is too large; try again, or attach a " +
        "smaller folder",
    );
  }
  if (count.files === 0) throw new Error("folder contains no ingestible files");
  return count;
}

function inspectZip(path: string): Promise<InventoryCount> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(error ?? new Error("could not open ZIP archive"));
          return;
        }
        const count: InventoryCount = { files: 0, bytes: 0 };
        let settled = false;
        const fail = (reason: unknown): void => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(reason);
        };
        zipFile.on("error", fail);
        zipFile.on("end", () => {
          if (settled) return;
          settled = true;
          if (count.files === 0) {
            reject(new Error("ZIP archive contains no ingestible files"));
          } else {
            resolvePromise(count);
          }
        });
        zipFile.on("entry", (entry: Entry) => {
          const isDirectory = entry.fileName.endsWith("/");
          const raw = isDirectory
            ? entry.fileName.slice(0, -1)
            : entry.fileName;
          if (raw === "") {
            zipFile.readEntry();
            return;
          }
          let safe: string;
          try {
            safe = safeArchiveRelativePath(raw);
          } catch (pathError) {
            fail(
              new Error(
                `ZIP contains an unsafe path: ${
                  pathError instanceof Error
                    ? pathError.message
                    : String(pathError)
                }`,
              ),
            );
            return;
          }
          const parts = safe.split("/");
          if (
            isDirectory ||
            parts.some((part) => JUNK_DIRECTORIES.has(part)) ||
            JUNK_FILES.has(parts.at(-1)!)
          ) {
            zipFile.readEntry();
            return;
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) {
            zipFile.readEntry();
            return;
          }
          if (entry.uncompressedSize > ATTACHMENT_LIMITS.maxFileBytes) {
            fail(new Error(`"${safe}" exceeds the per-file size limit`));
            return;
          }
          count.files += 1;
          count.bytes += entry.uncompressedSize;
          if (count.files > ATTACHMENT_LIMITS.maxFiles) {
            fail(
              new Error(
                `ZIP exceeds the ${ATTACHMENT_LIMITS.maxFiles}-file limit`,
              ),
            );
            return;
          }
          if (count.bytes > ATTACHMENT_LIMITS.maxTotalBytes) {
            fail(new Error("ZIP exceeds the total attachment size limit"));
            return;
          }
          zipFile.readEntry();
        });
        zipFile.readEntry();
      },
    );
  });
}

async function hasPdfHeader(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(5);
    const { bytesRead } = await handle.read(buffer, 0, 5, 0);
    return bytesRead === 5 && buffer.toString("ascii") === "%PDF-";
  } finally {
    await handle.close();
  }
}

/** Force an actual read rather than trusting access(2) alone. */
async function readFirstByte(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.read(Buffer.alloc(1), 0, 1, 0);
  } finally {
    await handle.close();
  }
}

export interface ServerFileBrowserOptions {
  readonly roots: readonly string[];
  /** Test/deployment overrides; every omitted field keeps its default. */
  readonly limits?: Partial<ServerFileBrowserLimits>;
}

export class ServerFileBrowser {
  readonly roots: readonly ServerAttachmentRoot[];
  private readonly rootPaths = new Map<string, string>();
  private readonly limits: ServerFileBrowserLimits;

  constructor(options: ServerFileBrowserOptions) {
    this.limits = { ...DEFAULT_SERVER_FILE_LIMITS, ...(options.limits ?? {}) };
    // Startup-only synchronous work: a handful of configured roots, resolved
    // once before the port opens. Everything request-driven below is async.
    const seen = new Set<string>();
    const roots: ServerAttachmentRoot[] = [];
    for (const configured of options.roots) {
      let path: string;
      try {
        path = realpathSync(resolve(configured));
        if (seen.has(path) || !statSync(path).isDirectory()) continue;
        accessSync(path, constants.R_OK | constants.X_OK);
      } catch {
        continue;
      }
      seen.add(path);
      const id = `root-${roots.length + 1}`;
      const label =
        path === realpathSync(homedir()) ? "Home" : basename(path) || path;
      roots.push({ id, label, path });
      this.rootPaths.set(id, path);
    }
    if (roots.length === 0) {
      throw new Error("no readable server attachment roots are configured");
    }
    this.roots = roots;
  }

  /**
   * Resolve a selected path to its canonical form. Any existing path is
   * accepted — the roots are bookmarks, not a boundary — and readability,
   * type, and size checks happen during validation and ingestion.
   */
  async resolveSelectedPath(path: string): Promise<string> {
    try {
      return await realpath(resolve(path));
    } catch {
      throw new ServerFileError(400, `path "${path}" does not exist`);
    }
  }

  /** Canonicalize job-submission references (URLs pass through untouched). */
  async canonicalizeReferences(paths: readonly string[]): Promise<string[]> {
    return Promise.all(
      paths.map((path) =>
        /^https?:\/\//i.test(path)
          ? Promise.resolve(path)
          : this.resolveSelectedPath(path),
      ),
    );
  }

  /** The canonical, readable directory a browse or search starts from. */
  private async resolveBase(
    rootId: string | undefined,
    requestedPath: string | undefined,
  ): Promise<{ id: string; base: string }> {
    const id = rootId ?? this.roots[0]!.id;
    const root = this.rootPaths.get(id);
    if (!root) throw new ServerFileError(400, `unknown attachment root "${id}"`);
    const candidate = requestedPath ? resolve(requestedPath) : root;
    let base: string;
    try {
      base = await realpath(candidate);
    } catch {
      throw new ServerFileError(400, `folder "${candidate}" does not exist`);
    }
    if (!(await stat(base)).isDirectory() || !(await readable(base, true))) {
      throw new ServerFileError(400, `"${base}" is not a readable folder`);
    }
    return { id, base };
  }

  async browse(
    rootId: string | undefined,
    requestedPath: string | undefined,
    kind: AttachmentSelectionKind,
    signal?: AbortSignal,
  ): Promise<BrowseServerFilesResponse> {
    const { id, base: current } = await this.resolveBase(rootId, requestedPath);
    const bounds: WalkBounds = {
      deadlineAt: Date.now() + this.limits.browseDeadlineMs,
      signal,
    };

    const children = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => !skipChildName(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    // Capped BEFORE classification, on the name-sorted list, so which entries
    // survive a pathological directory is deterministic.
    let truncated = children.length > this.limits.browseMaxEntries;
    const capped = children.slice(0, this.limits.browseMaxEntries);

    const entries: ServerFileEntry[] = [];
    await pumpQueue([...capped], this.limits.concurrency, async (child) => {
      if (outOfTime(bounds)) {
        truncated = true;
        return;
      }
      const classified = await classifyChild(current, child);
      if (!classified) return;
      let stats = classified.stats;
      if (!stats) {
        try {
          stats = await stat(classified.path);
        } catch {
          return;
        }
      }
      const isDirectory = classified.isDirectory;
      const canRead = await readable(classified.path, isDirectory);
      const match = typeMatch(kind, classified.path, isDirectory);
      entries.push({
        name: classified.name,
        path: classified.path,
        kind: isDirectory ? "folder" : "file",
        ...(isDirectory ? {} : { bytes: stats.size }),
        modifiedAt: stats.mtimeMs,
        selectable: canRead && match.selectable,
        ...(!canRead
          ? { reason: "Not readable by the server process." }
          : match.reason
            ? { reason: match.reason }
            : {}),
      });
    });
    sortEntries(entries);
    const parent = resolve(current, "..");
    return {
      roots: this.roots,
      rootId: id,
      currentPath: current,
      ...(parent !== current ? { parentPath: parent } : {}),
      entries,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /**
   * Bounded recursive name search under one currently browsed directory.
   * This searches server metadata only; it never reads file contents.
   *
   * Cost model, because this is the hottest walk of the picker: one readdir
   * per directory, then a stat ONLY for entries whose name matches the query
   * (at most maxResults) and for symlinks. Directories are enqueued straight
   * from their dirent — the old per-child realpath+stat+access tripled every
   * network filesystem's latency across the entire tree.
   */
  async search(
    rootId: string | undefined,
    requestedPath: string | undefined,
    kind: AttachmentSelectionKind,
    rawQuery: string,
    signal?: AbortSignal,
  ): Promise<SearchServerFilesResponse> {
    const query = rawQuery.trim().toLowerCase();
    if (query.length < 2 || query.length > 100) {
      throw new ServerFileError(
        400,
        "search query must contain 2–100 characters",
      );
    }
    const { id, base: basePath } = await this.resolveBase(
      rootId,
      requestedPath,
    );
    const bounds: WalkBounds = {
      deadlineAt: Date.now() + this.limits.searchDeadlineMs,
      signal,
    };
    const { searchMaxResults, searchMaxDirectories, searchMaxDepth } =
      this.limits;

    const entries: ServerFileEntry[] = [];
    const queue: Array<{ path: string; depth: number }> = [
      { path: basePath, depth: 0 },
    ];
    const visited = new Set<string>([basePath]);
    let directories = 0;
    let truncated = false;
    const stopEarly = (): void => {
      truncated = true;
      queue.length = 0;
    };

    await pumpQueue(queue, this.limits.concurrency, async (current) => {
      if (outOfTime(bounds)) {
        stopEarly();
        return;
      }
      directories += 1;
      if (directories > searchMaxDirectories) {
        stopEarly();
        return;
      }
      let children: Dirent[];
      try {
        children = await readdir(current.path, { withFileTypes: true });
      } catch {
        // An unreadable or vanished directory is not a search failure.
        return;
      }
      for (const child of children) {
        if (entries.length >= searchMaxResults) {
          stopEarly();
          return;
        }
        if (skipChildName(child.name)) continue;
        const matches = child.name.toLowerCase().includes(query);
        // A non-matching plain file needs nothing further; only matches and
        // traversable entries are worth another filesystem call.
        if (!matches && child.isFile()) continue;
        const classified = await classifyChild(current.path, child);
        if (!classified) continue;
        if (
          classified.isDirectory &&
          current.depth < searchMaxDepth &&
          !visited.has(classified.path)
        ) {
          visited.add(classified.path);
          queue.push({ path: classified.path, depth: current.depth + 1 });
        }
        if (!matches) continue;
        const match = typeMatch(kind, classified.path, classified.isDirectory);
        // Directories are always useful navigation results; files only
        // appear when they match the selected attachment type.
        if (!classified.isDirectory && !match.selectable) continue;
        let stats = classified.stats;
        if (!stats) {
          try {
            stats = await stat(classified.path);
          } catch {
            continue;
          }
        }
        const canRead = await readable(classified.path, classified.isDirectory);
        entries.push({
          name: classified.name,
          path: classified.path,
          kind: classified.isDirectory ? "folder" : "file",
          ...(classified.isDirectory ? {} : { bytes: stats.size }),
          modifiedAt: stats.mtimeMs,
          selectable: canRead && match.selectable,
          ...(!canRead
            ? { reason: "Not readable by the server process." }
            : match.reason
              ? { reason: match.reason }
              : {}),
        });
        if (entries.length >= searchMaxResults) {
          stopEarly();
          return;
        }
      }
    });
    sortEntries(entries);
    return {
      rootId: id,
      basePath,
      query: rawQuery.trim(),
      entries: entries.slice(0, searchMaxResults),
      truncated,
    };
  }

  async validate(
    kind: AttachmentSelectionKind,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ValidatedAttachment[]> {
    return Promise.all(
      paths.map(async (rawPath): Promise<ValidatedAttachment> => {
        try {
          if (kind === "web") {
            const inspected = await inspectWebAttachment(rawPath);
            return {
              path: inspected.url,
              name: inspected.url,
              kind,
              valid: true,
              readable: true,
              files: 1,
              ...(inspected.bytes !== undefined
                ? { bytes: inspected.bytes }
                : {}),
            };
          }
          const path = await this.resolveSelectedPath(rawPath);
          const stats = await stat(path);
          const isDirectory = stats.isDirectory();
          const match = typeMatch(kind, path, isDirectory);
          if (!match.selectable) throw new Error(match.reason);
          if (!(await readable(path, isDirectory))) {
            return {
              path,
              name: basename(path),
              kind,
              valid: false,
              readable: false,
              reason: "Not readable by the server process.",
            };
          }

          let inventory: InventoryCount;
          if (isDirectory) {
            inventory = await inspectTree(path, this.limits.concurrency, {
              deadlineAt: Date.now() + this.limits.validateDeadlineMs,
              signal,
            });
          } else if (
            kind === "zip" ||
            (kind === "file" && extname(path).toLowerCase() === ".zip")
          ) {
            inventory = await inspectZip(path);
          } else {
            if (stats.size > ATTACHMENT_LIMITS.maxFileBytes) {
              throw new Error("file exceeds the per-file size limit");
            }
            if (kind === "pdf" && !(await hasPdfHeader(path))) {
              throw new Error("file does not have a valid PDF header");
            }
            await readFirstByte(path);
            inventory = { files: 1, bytes: stats.size };
          }
          return {
            path,
            name: basename(path),
            kind,
            valid: true,
            readable: true,
            files: inventory.files,
            bytes: inventory.bytes,
          };
        } catch (error) {
          return {
            path: rawPath,
            name: basename(rawPath) || rawPath,
            kind,
            valid: false,
            readable: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
}
