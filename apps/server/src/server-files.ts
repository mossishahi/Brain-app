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
 */
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
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

function readable(path: string, directory: boolean): boolean {
  try {
    accessSync(
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

interface InventoryCount {
  files: number;
  bytes: number;
}

function inspectTree(root: string): InventoryCount {
  const count: InventoryCount = { files: 0, bytes: 0 };
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!JUNK_DIRECTORIES.has(entry.name)) walk(path);
        continue;
      }
      if (!entry.isFile() || JUNK_FILES.has(entry.name)) continue;
      if (!readable(path, false)) {
        throw new Error(`"${path}" is not readable`);
      }
      const bytes = statSync(path).size;
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
  };
  walk(root);
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

function hasPdfHeader(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(5);
    return readSync(fd, buffer, 0, 5, 0) === 5 &&
      buffer.toString("ascii") === "%PDF-";
  } finally {
    closeSync(fd);
  }
}

function readFirstByte(path: string): void {
  const fd = openSync(path, "r");
  try {
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
  } finally {
    closeSync(fd);
  }
}

export interface ServerFileBrowserOptions {
  readonly roots: readonly string[];
}

export class ServerFileBrowser {
  readonly roots: readonly ServerAttachmentRoot[];
  private readonly rootPaths = new Map<string, string>();

  constructor(options: ServerFileBrowserOptions) {
    const seen = new Set<string>();
    const roots: ServerAttachmentRoot[] = [];
    for (const configured of options.roots) {
      let path: string;
      try {
        path = realpathSync(resolve(configured));
      } catch {
        continue;
      }
      if (
        seen.has(path) ||
        !statSync(path).isDirectory() ||
        !readable(path, true)
      ) {
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
  resolveSelectedPath(path: string): string {
    try {
      return realpathSync(resolve(path));
    } catch {
      throw new ServerFileError(400, `path "${path}" does not exist`);
    }
  }

  /** Canonicalize job-submission references (URLs pass through untouched). */
  canonicalizeReferences(paths: readonly string[]): string[] {
    return paths.map((path) =>
      /^https?:\/\//i.test(path) ? path : this.resolveSelectedPath(path),
    );
  }

  browse(
    rootId: string | undefined,
    requestedPath: string | undefined,
    kind: AttachmentSelectionKind,
  ): BrowseServerFilesResponse {
    const id = rootId ?? this.roots[0]!.id;
    const root = this.rootPaths.get(id);
    if (!root) throw new ServerFileError(400, `unknown attachment root "${id}"`);
    const candidate = requestedPath ? resolve(requestedPath) : root;
    let current: string;
    try {
      current = realpathSync(candidate);
    } catch {
      throw new ServerFileError(400, `folder "${candidate}" does not exist`);
    }
    if (!statSync(current).isDirectory() || !readable(current, true)) {
      throw new ServerFileError(400, `"${current}" is not a readable folder`);
    }

    const entries: ServerFileEntry[] = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // The picker is for scientific inputs, not repository internals or
      // operating-system metadata. These entries are also skipped by the
      // snapshotter, so hiding them here keeps browse and ingestion aligned.
      if (
        entry.name.startsWith(".") ||
        JUNK_DIRECTORIES.has(entry.name) ||
        JUNK_FILES.has(entry.name)
      ) {
        continue;
      }
      const unresolved = join(current, entry.name);
      let path: string;
      let stat;
      try {
        // Symlinks are followed wherever they lead: on HPC hosts the useful
        // storage ($HOME/scratch -> /scratch/user) usually lives outside the
        // starting root.
        path = realpathSync(unresolved);
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) continue;
      const isDirectory = stat.isDirectory();
      const canRead = readable(path, isDirectory);
      const match = typeMatch(kind, path, isDirectory);
      entries.push({
        name: entry.name,
        path,
        kind: isDirectory ? "folder" : "file",
        ...(isDirectory ? {} : { bytes: stat.size }),
        modifiedAt: stat.mtimeMs,
        selectable: canRead && match.selectable,
        ...(!canRead
          ? { reason: "Not readable by the server process." }
          : match.reason
            ? { reason: match.reason }
            : {}),
      });
    }
    entries.sort(
      (left, right) =>
        (left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === "folder"
            ? -1
            : 1),
    );
    const parent = resolve(current, "..");
    return {
      roots: this.roots,
      rootId: id,
      currentPath: current,
      ...(parent !== current ? { parentPath: parent } : {}),
      entries,
    };
  }

  /**
   * Bounded recursive name search under one currently browsed directory.
   * This searches server metadata only; it never reads file contents.
   */
  search(
    rootId: string | undefined,
    requestedPath: string | undefined,
    kind: AttachmentSelectionKind,
    rawQuery: string,
  ): SearchServerFilesResponse {
    const query = rawQuery.trim().toLowerCase();
    if (query.length < 2 || query.length > 100) {
      throw new ServerFileError(
        400,
        "search query must contain 2–100 characters",
      );
    }
    const id = rootId ?? this.roots[0]!.id;
    const root = this.rootPaths.get(id);
    if (!root) {
      throw new ServerFileError(400, `unknown attachment root "${id}"`);
    }
    const candidate = requestedPath ? resolve(requestedPath) : root;
    let basePath: string;
    try {
      basePath = realpathSync(candidate);
    } catch {
      throw new ServerFileError(400, `folder "${candidate}" does not exist`);
    }
    if (!statSync(basePath).isDirectory() || !readable(basePath, true)) {
      throw new ServerFileError(400, `"${basePath}" is not a readable folder`);
    }

    const maxResults = 100;
    const maxDirectories = 750;
    const maxDepth = 8;
    const entries: ServerFileEntry[] = [];
    const queue: Array<{ path: string; depth: number }> = [
      { path: basePath, depth: 0 },
    ];
    const visited = new Set<string>();
    let directories = 0;
    let truncated = false;

    while (queue.length > 0 && entries.length < maxResults) {
      const current = queue.shift()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      directories += 1;
      if (directories > maxDirectories) {
        truncated = true;
        break;
      }
      let children: Dirent[];
      try {
        children = readdirSync(current.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (
          child.name.startsWith(".") ||
          JUNK_DIRECTORIES.has(child.name) ||
          JUNK_FILES.has(child.name)
        ) {
          continue;
        }
        let path: string;
        let stat;
        try {
          path = realpathSync(join(current.path, child.name));
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!stat.isDirectory() && !stat.isFile()) continue;
        const isDirectory = stat.isDirectory();
        const canRead = readable(path, isDirectory);
        if (
          isDirectory &&
          canRead &&
          current.depth < maxDepth &&
          !visited.has(path)
        ) {
          queue.push({ path, depth: current.depth + 1 });
        }
        if (!child.name.toLowerCase().includes(query)) continue;
        const match = typeMatch(kind, path, isDirectory);
        // Directories are always useful navigation results; files only
        // appear when they match the selected attachment type.
        if (!isDirectory && !match.selectable) continue;
        entries.push({
          name: child.name,
          path,
          kind: isDirectory ? "folder" : "file",
          ...(isDirectory ? {} : { bytes: stat.size }),
          modifiedAt: stat.mtimeMs,
          selectable: canRead && match.selectable,
          ...(!canRead
            ? { reason: "Not readable by the server process." }
            : match.reason
              ? { reason: match.reason }
              : {}),
        });
        if (entries.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    }
    if (queue.length > 0) truncated = true;
    entries.sort(
      (left, right) =>
        (left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind === "folder"
            ? -1
            : 1),
    );
    return {
      rootId: id,
      basePath,
      query: rawQuery.trim(),
      entries,
      truncated,
    };
  }

  async validate(
    kind: AttachmentSelectionKind,
    paths: readonly string[],
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
          const path = this.resolveSelectedPath(rawPath);
          const stat = statSync(path);
          const isDirectory = stat.isDirectory();
          const match = typeMatch(kind, path, isDirectory);
          if (!match.selectable) throw new Error(match.reason);
          if (!readable(path, isDirectory)) {
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
            inventory = inspectTree(path);
          } else if (
            kind === "zip" ||
            (kind === "file" && extname(path).toLowerCase() === ".zip")
          ) {
            inventory = await inspectZip(path);
          } else {
            if (stat.size > ATTACHMENT_LIMITS.maxFileBytes) {
              throw new Error("file exceeds the per-file size limit");
            }
            if (kind === "pdf" && !hasPdfHeader(path)) {
              throw new Error("file does not have a valid PDF header");
            }
            // Force an actual read rather than trusting access(2) alone.
            readFirstByte(path);
            inventory = { files: 1, bytes: stat.size };
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
