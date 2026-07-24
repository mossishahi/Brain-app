/**
 * Attachment ingestion: turn user-supplied paths and URLs into an immutable,
 * job-local attachment store plus a manifest the orchestration run consumes.
 *
 * Standard pipeline: classify each spec (folder / zip / pdf / image / video /
 * web / file), materialize a snapshot under the job's `attachments/`
 * directory (copy trees, extract archives, fetch URLs), and record every
 * contained file in a bounded inventory. Later pipeline stages never touch
 * the user's original paths — only the snapshot — so resubmission and resume
 * are reproducible even when the sources change.
 */
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl, { type Entry } from "yauzl";

import { ATTACHMENT_LIMITS } from "@brainstorm-agentic/protocol";

export interface IngestedFileEntry {
  /** Absolute path of the snapshot file (valid on any host sharing the workspace). */
  readonly path: string;
  readonly bytes: number;
}

export type AttachmentKind =
  | "folder"
  | "zip"
  | "pdf"
  | "image"
  | "video"
  | "web"
  | "file";

export interface IngestedAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  /** The user's original path or URL. */
  readonly origin: string;
  /** Ingestion notes: extractions, skipped junk, truncations, unreadable media. */
  readonly notes: readonly string[];
  readonly files: readonly IngestedFileEntry[];
}

export interface AttachmentManifest {
  readonly version: 1;
  readonly baseDir: string;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly attachments: readonly IngestedAttachment[];
}

export interface IngestOptions {
  /** Inventory ceiling across all attachments (matches the workflow's maxAttachmentFiles). */
  readonly maxFiles?: number;
  /** Per-file snapshot ceiling. */
  readonly maxFileBytes?: number;
  /** Total snapshot ceiling. */
  readonly maxTotalBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly lookupImpl?: typeof lookup;
  readonly fetchTimeoutMs?: number;
}

const DEFAULT_MAX_FILES = ATTACHMENT_LIMITS.maxFiles;
const DEFAULT_MAX_FILE_BYTES = ATTACHMENT_LIMITS.maxFileBytes;
const DEFAULT_MAX_TOTAL_BYTES = ATTACHMENT_LIMITS.maxTotalBytes;

/** Directories that never carry scientific content; skipped wholesale. */
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
  ".idea",
  ".vscode",
]);

const JUNK_FILES = new Set([".DS_Store", "Thumbs.db"]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tif", ".tiff",
]);
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv",
]);

const CONTENT_TYPE_EXTENSIONS: readonly (readonly [RegExp, string])[] = [
  [/text\/html/i, ".html"],
  [/application\/pdf/i, ".pdf"],
  [/application\/json/i, ".json"],
  [/text\/plain/i, ".txt"],
  [/text\/markdown/i, ".md"],
  [/image\/png/i, ".png"],
  [/image\/jpe?g/i, ".jpg"],
  [/image\/gif/i, ".gif"],
  [/image\/webp/i, ".webp"],
  [/text\/csv/i, ".csv"],
  [/application\/xml|text\/xml/i, ".xml"],
];

export class AttachmentIngestError extends Error {
  constructor(spec: string, reason: string) {
    super(`attachment "${spec}" could not be ingested: ${reason}`);
    this.name = "AttachmentIngestError";
  }
}

function isWebUrl(spec: string): boolean {
  return /^https?:\/\//i.test(spec);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function slug(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "attachment";
}

function classifyPath(path: string): AttachmentKind {
  const stat = statSync(path);
  if (stat.isDirectory()) return "folder";
  const ext = extname(path).toLowerCase();
  if (ext === ".zip") return "zip";
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "file";
}

/**
 * Archive entry paths are untrusted input. Return a normalized POSIX-style
 * relative path or throw before any filesystem operation.
 */
export function safeArchiveRelativePath(raw: string): string {
  if (raw.length === 0 || raw.length > 1024 || raw.includes("\0")) {
    throw new Error("archive entry has an invalid relative path");
  }
  const forward = raw.replace(/\\/g, "/");
  if (forward.startsWith("/") || /^[A-Za-z]:\//.test(forward)) {
    throw new Error(`archive path "${raw}" must be relative`);
  }
  const parts = forward.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.length > 255,
    )
  ) {
    throw new Error(`archive path "${raw}" contains an unsafe segment`);
  }
  // `normalize` is a second defensive check against platform-specific path
  // semantics before joining it under a job-owned directory.
  const platform = normalize(parts.join("/"));
  if (isAbsolute(platform) || platform.startsWith(`..${String.fromCharCode(47)}`)) {
    throw new Error(`archive path "${raw}" escapes its attachment`);
  }
  return parts.join("/");
}

interface WalkBudget {
  remainingFiles: number;
  remainingBytes: number;
  readonly maxFileBytes: number;
}

interface WalkResult {
  readonly files: IngestedFileEntry[];
  readonly notes: string[];
}

/** Copy a tree into the snapshot, applying junk filters and budgets. */
function copyTree(source: string, destination: string, budget: WalkBudget): WalkResult {
  const files: IngestedFileEntry[] = [];
  const notes: string[] = [];
  let skippedJunk = 0;
  let skippedLarge = 0;
  let truncated = false;

  const walk = (from: string, to: string): void => {
    if (truncated) return;
    const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (truncated) return;
      const fromPath = join(from, entry.name);
      if (entry.isSymbolicLink()) {
        skippedJunk += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (JUNK_DIRECTORIES.has(entry.name)) {
          skippedJunk += 1;
          continue;
        }
        walk(fromPath, join(to, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (JUNK_FILES.has(entry.name)) {
        skippedJunk += 1;
        continue;
      }
      const bytes = statSync(fromPath).size;
      if (bytes > budget.maxFileBytes) {
        skippedLarge += 1;
        continue;
      }
      if (budget.remainingFiles <= 0 || budget.remainingBytes < bytes) {
        truncated = true;
        return;
      }
      const toPath = join(to, entry.name);
      mkdirSync(to, { recursive: true });
      copyFileSync(fromPath, toPath);
      budget.remainingFiles -= 1;
      budget.remainingBytes -= bytes;
      files.push({ path: toPath, bytes });
    }
  };

  walk(source, destination);
  if (skippedJunk > 0) notes.push(`skipped ${skippedJunk} junk or link entr${skippedJunk === 1 ? "y" : "ies"}`);
  if (skippedLarge > 0) notes.push(`skipped ${skippedLarge} file(s) over the per-file size limit`);
  if (truncated) notes.push("inventory truncated at the attachment budget; remaining files were not copied");
  return { files, notes };
}

/**
 * Stream a ZIP through yauzl's lazy-entry API. Every entry path is validated
 * before joining it under `destination`, symlinks are skipped, and declared
 * uncompressed sizes are checked against both per-file and total budgets
 * before bytes hit disk. This is safe for untrusted archives and does not
 * depend on an `unzip` binary being installed on the server host.
 */
function extractZip(
  zipPath: string,
  destination: string,
  budget: WalkBudget,
): Promise<WalkResult> {
  mkdirSync(destination, { recursive: true });
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          rejectPromise(openError ?? new Error("could not open zip archive"));
          return;
        }
        const files: IngestedFileEntry[] = [];
        const seen = new Set<string>();
        let skippedJunk = 0;
        let skippedLinks = 0;
        let skippedLarge = 0;
        let truncated = false;
        let settled = false;

        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          zipFile.close();
          rmSync(destination, { recursive: true, force: true });
          rejectPromise(error);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          const notes: string[] = [];
          if (skippedJunk > 0) {
            notes.push(`skipped ${skippedJunk} junk archive entr${skippedJunk === 1 ? "y" : "ies"}`);
          }
          if (skippedLinks > 0) {
            notes.push(`skipped ${skippedLinks} symbolic link(s) from the archive`);
          }
          if (skippedLarge > 0) {
            notes.push(`skipped ${skippedLarge} archive file(s) over the per-file size limit`);
          }
          if (truncated) {
            notes.push("archive truncated at the attachment budget");
          }
          resolvePromise({ files, notes });
        };

        zipFile.on("error", fail);
        zipFile.on("end", finish);
        zipFile.on("entry", (entry: Entry) => {
          void (async () => {
            const directory = entry.fileName.endsWith("/");
            const rawName = directory
              ? entry.fileName.slice(0, -1)
              : entry.fileName;
            if (rawName === "") {
              zipFile.readEntry();
              return;
            }
            let relativePath: string;
            try {
              relativePath = safeArchiveRelativePath(rawName);
            } catch (error) {
              fail(
                new Error(
                  `zip archive contains an unsafe entry path: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
              );
              return;
            }
            const parts = relativePath.split("/");
            if (
              parts.some((part) => JUNK_DIRECTORIES.has(part)) ||
              JUNK_FILES.has(parts.at(-1)!)
            ) {
              skippedJunk += 1;
              zipFile.readEntry();
              return;
            }
            if (directory) {
              zipFile.readEntry();
              return;
            }
            if (seen.has(relativePath)) {
              fail(new Error(`zip archive contains duplicate path "${relativePath}"`));
              return;
            }
            seen.add(relativePath);

            // Unix mode is stored in the high 16 bits. Ignore links rather
            // than materializing their target.
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (mode === 0o120000) {
              skippedLinks += 1;
              zipFile.readEntry();
              return;
            }
            const bytes = entry.uncompressedSize;
            if (bytes > budget.maxFileBytes) {
              skippedLarge += 1;
              zipFile.readEntry();
              return;
            }
            if (budget.remainingFiles <= 0 || budget.remainingBytes < bytes) {
              truncated = true;
              zipFile.close();
              finish();
              return;
            }

            const target = join(destination, ...relativePath.split("/"));
            mkdirSync(resolve(target, ".."), { recursive: true });
            zipFile.openReadStream(entry, (streamError, stream) => {
              if (streamError || !stream) {
                fail(streamError ?? new Error(`could not read "${relativePath}"`));
                return;
              }
              void pipeline(stream, createWriteStream(target, { flags: "wx" }))
                .then(() => {
                  budget.remainingFiles -= 1;
                  budget.remainingBytes -= bytes;
                  files.push({ path: target, bytes });
                  zipFile.readEntry();
                })
                .catch(fail);
            });
          })().catch(fail);
        });
        zipFile.readEntry();
      },
    );
  });
}

function extensionForContentType(contentType: string | null): string {
  if (!contentType) return ".bin";
  for (const [pattern, ext] of CONTENT_TYPE_EXTENSIONS) {
    if (pattern.test(contentType)) return ext;
  }
  return ".bin";
}

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    // Documentation/reserved networks are not useful attachment origins.
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function privateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version !== 6) return true;
  const normalizedAddress = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalizedAddress);
  if (mapped) return privateIpv4(mapped[1]!);
  return (
    normalizedAddress === "::" ||
    normalizedAddress === "::1" ||
    normalizedAddress.startsWith("fc") ||
    normalizedAddress.startsWith("fd") ||
    /^fe[89ab]/.test(normalizedAddress) ||
    normalizedAddress.startsWith("ff") ||
    normalizedAddress.startsWith("2001:db8:")
  );
}

/**
 * SSRF guard for server-side URL attachments. Resolve every hostname and
 * reject loopback/private/link-local/reserved destinations. Redirect targets
 * are checked again by `fetchWebAttachment`.
 */
export async function assertPublicWebUrl(
  rawUrl: string,
  lookupImpl: typeof lookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("URL must be public http(s) without embedded credentials");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("URL points to a local or private host");
  }
  if (isIP(host)) {
    if (privateIp(host)) throw new Error("URL points to a private or reserved address");
    return url;
  }
  const addresses = await lookupImpl(host, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((entry) => privateIp(entry.address))
  ) {
    throw new Error("URL resolves to a private or reserved address");
  }
  return url;
}

/** Fast server-side availability check used when the user picks a web URL. */
export async function inspectWebAttachment(
  rawUrl: string,
  options: Pick<
    IngestOptions,
    "fetchImpl" | "lookupImpl" | "fetchTimeoutMs"
  > = {},
): Promise<{ readonly url: string; readonly bytes?: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? lookup;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("URL validation timed out")),
    options.fetchTimeoutMs ?? 10_000,
  );
  try {
    let current = rawUrl;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const checked = await assertPublicWebUrl(current, lookupImpl);
      let response = await fetchImpl(checked, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status === 405 || response.status === 501) {
        response = await fetchImpl(checked, {
          method: "GET",
          headers: { range: "bytes=0-0" },
          signal: controller.signal,
          redirect: "manual",
        });
      }
      const location = response.headers.get("location");
      if (
        response.status >= 300 &&
        response.status < 400 &&
        location !== null
      ) {
        if (redirect === 5) throw new Error("URL redirected too many times");
        await response.body?.cancel();
        current = new URL(location, checked).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`URL returned HTTP ${response.status}`);
      }
      const length = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(length) &&
        length > ATTACHMENT_LIMITS.maxFileBytes
      ) {
        await response.body?.cancel();
        throw new Error("URL content exceeds the per-file size limit");
      }
      await response.body?.cancel();
      return {
        url: checked.href,
        ...(Number.isFinite(length) && length >= 0 ? { bytes: length } : {}),
      };
    }
    throw new Error("URL redirected too many times");
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWebAttachment(
  url: string,
  directory: string,
  budget: WalkBudget,
  options: IngestOptions,
): Promise<WalkResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? lookup;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("fetch timed out")),
    options.fetchTimeoutMs ?? 30_000,
  );
  let response: Response | undefined;
  let current = url;
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const checked = await assertPublicWebUrl(current, lookupImpl);
      response = await fetchImpl(checked, {
        signal: controller.signal,
        redirect: "manual",
      });
      if (
        response.status < 300 ||
        response.status >= 400 ||
        !response.headers.get("location")
      ) {
        break;
      }
      if (redirect === 5) throw new Error("URL redirected too many times");
      current = new URL(response.headers.get("location")!, checked).href;
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!response) throw new Error("URL fetch produced no response");
  if (!response.ok) {
    throw new Error(`request returned HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > budget.maxFileBytes) {
    throw new Error(
      `fetched content is ${body.byteLength} bytes which exceeds the per-file limit`,
    );
  }
  if (budget.remainingFiles <= 0 || budget.remainingBytes < body.byteLength) {
    throw new Error("the attachment budget is exhausted");
  }
  const contentType = response.headers.get("content-type");
  const pathName = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  const base = slug(basename(pathName) || "page");
  const name = extname(base) !== "" ? base : `${base}${extensionForContentType(contentType)}`;
  mkdirSync(directory, { recursive: true });
  const target = join(directory, name);
  writeFileSync(target, body);
  budget.remainingFiles -= 1;
  budget.remainingBytes -= body.byteLength;
  return {
    files: [{ path: target, bytes: body.byteLength }],
    notes: [
      `fetched ${body.byteLength} bytes${contentType ? ` (${contentType.split(";")[0]})` : ""} from the URL`,
    ],
  };
}

function copySingleFile(
  source: string,
  directory: string,
  budget: WalkBudget,
): WalkResult {
  const bytes = statSync(source).size;
  if (bytes > budget.maxFileBytes) {
    throw new Error(`file is ${bytes} bytes which exceeds the per-file limit`);
  }
  if (budget.remainingFiles <= 0 || budget.remainingBytes < bytes) {
    throw new Error("the attachment budget is exhausted");
  }
  mkdirSync(directory, { recursive: true });
  const target = join(directory, slug(basename(source)));
  copyFileSync(source, target);
  budget.remainingFiles -= 1;
  budget.remainingBytes -= bytes;
  return { files: [{ path: target, bytes }], notes: [] };
}

/**
 * Ingest every spec into `baseDir`. Throws AttachmentIngestError on the first
 * spec that cannot be ingested — a job is either fully materialized or not
 * created at all.
 */
export async function ingestAttachments(
  specs: readonly string[],
  baseDir: string,
  options: IngestOptions = {},
): Promise<AttachmentManifest> {
  const budget: WalkBudget = {
    remainingFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    remainingBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  };
  mkdirSync(baseDir, { recursive: true });
  const attachments: IngestedAttachment[] = [];

  for (const [index, rawSpec] of specs.entries()) {
    const spec = rawSpec.trim();
    if (spec.length === 0) {
      throw new AttachmentIngestError(rawSpec, "empty attachment reference");
    }
    try {
      if (isWebUrl(spec)) {
        const id = `${index + 1}-web`;
        const directory = join(baseDir, id);
        const result = await fetchWebAttachment(spec, directory, budget, options);
        attachments.push({
          id,
          name: basename(result.files[0]!.path),
          kind: "web",
          origin: spec,
          notes: result.notes,
          files: result.files,
        });
        continue;
      }

      const sourcePath = resolve(expandHome(spec));
      const kind = classifyPath(sourcePath);
      const name = basename(sourcePath);
      const id = `${index + 1}-${slug(name)}`;
      const directory = join(baseDir, id);

      if (kind === "folder") {
        const result = copyTree(sourcePath, directory, budget);
        if (result.files.length === 0) {
          throw new Error("the folder contains no ingestible files");
        }
        attachments.push({
          id,
          name,
          kind,
          origin: sourcePath,
          notes: [`copied ${result.files.length} file(s)`, ...result.notes],
          files: result.files,
        });
      } else if (kind === "zip") {
        const result = await extractZip(sourcePath, directory, budget);
        if (result.files.length === 0) {
          throw new Error("the archive contains no ingestible files");
        }
        attachments.push({
          id,
          name,
          kind,
          origin: sourcePath,
          notes: [
            `extracted ${result.files.length} file(s) from the archive`,
            ...result.notes,
          ],
          files: result.files,
        });
      } else {
        const result = copySingleFile(sourcePath, directory, budget);
        attachments.push({
          id,
          name,
          kind,
          origin: sourcePath,
          notes:
            kind === "video"
              ? [
                  "video content is not machine-readable by the current model providers; only its name and metadata inform the run",
                ]
              : result.notes,
          files: result.files,
        });
      }
    } catch (error) {
      if (error instanceof AttachmentIngestError) throw error;
      const reason =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "no such file or directory"
          : error instanceof Error
            ? error.message
            : String(error);
      throw new AttachmentIngestError(spec, reason);
    }
  }

  const totalFiles = attachments.reduce((sum, a) => sum + a.files.length, 0);
  const totalBytes = attachments.reduce(
    (sum, a) => sum + a.files.reduce((nested, f) => nested + f.bytes, 0),
    0,
  );
  return { version: 1, baseDir, totalFiles, totalBytes, attachments };
}


