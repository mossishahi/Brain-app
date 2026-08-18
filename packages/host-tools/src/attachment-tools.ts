/**
 * Provider-neutral attachment tools satisfying the `attachment-access` capability.
 *
 * - `attachment_list` returns the inventory under the job's attachment store,
 *   flat or as a nested tree.
 * - `attachment_read` returns one file: text as text, images/PDFs as
 *   provider-neutral rich blocks (base64), and an honest refusal for media
 *   this transport cannot carry.
 * - `attachment_search` greps every attached text file for a literal or
 *   regex query and returns structured matches (path, line number, line) —
 *   the deterministic replacement for reading files one by one to locate
 *   something.
 *
 * Every path is resolved against the ingested attachment roots and rejected
 * when it escapes them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import type { JsonValue, Tool } from "@brainstorm-agentic/core";
import type { HostToolManifest } from "@brainstorm-agentic/core";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".tex",
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".csv", ".tsv", ".xml", ".html", ".htm", ".css",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".rs", ".go", ".java", ".kt",
  ".r", ".jl", ".m", ".sh", ".bash", ".zsh", ".sql", ".proto",
  ".bib", ".log",
]);

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_TEXT_CHARS = 48_000;
/** Provider-typical image cap (~5 MB raw); base64 inflates by 4/3. */
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/** Files above this size are skipped by attachment_search (reported, not silent). */
const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;
/** Default / hard cap on matching lines returned by attachment_search. */
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 500;
/** A matched line longer than this is trimmed around the first match. */
const MAX_MATCH_LINE_CHARS = 300;

export function insideRoots(roots: readonly string[], path: string): boolean {
  const target = resolve(path);
  return roots.some((root) => {
    const rel = relative(resolve(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8192);
  return window.includes(0);
}

/**
 * The host's own record of what it ingested, which lives AT the root of the
 * store it describes. Every submitted file is materialized one directory down,
 * so a file with this name at the top level is never the submitter's: listing it
 * would present host bookkeeping as an attachment and put the inventory one
 * ahead of the count the manifest itself reports.
 */
const INGEST_BOOKKEEPING = "manifest.json";

/** Depth-first walk of the attachment roots, in stable name order. */
function walkRoots(
  roots: readonly string[],
  visit: (path: string, bytes: number) => void,
): void {
  const walk = (dir: string, atRoot: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, false);
      else if (atRoot && entry.name === INGEST_BOOKKEEPING) continue;
      else if (entry.isFile()) visit(path, statSync(path).size);
    }
  };
  for (const root of roots) walk(root, true);
}

/** True when the file is searchable text (known extension or non-binary sniff). */
function isSearchableText(path: string, buffer: Buffer): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || !looksBinary(buffer);
}

function ok(output: JsonValue) {
  return { output };
}

function record(value: unknown): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function refusal(message: string) {
  return { output: message, isError: true as const };
}

// ---------------------------------------------------------------------------
// Tool definitions (shared between manifests and runtime)
// ---------------------------------------------------------------------------

const ATTACHMENT_LIST_DEFINITION = {
  name: "attachment_list",
  description:
    "List the files of the submission's ingested attachments (path and size in bytes). " +
    "Optionally filter by a path prefix, and choose the response shape: a flat list " +
    "(default) or a nested directory tree for a compact overview of large stores.",
  inputSchema: {
    type: "object",
    properties: {
      prefix: {
        type: "string",
        description: "Only return files whose path starts with this prefix.",
      },
      shape: {
        type: "string",
        enum: ["flat", "tree"],
        description:
          'Response shape. "flat" (default) returns {files: [{path, bytes}]}; "tree" returns ' +
          "a nested object per root where directories are objects and files map to byte sizes.",
      },
    },
    additionalProperties: false,
  },
} as const;

const ATTACHMENT_SEARCH_DEFINITION = {
  name: "attachment_search",
  description:
    "Search every attached text file for a word, phrase, or regular expression in one call. " +
    "Returns structured matches — file path, 1-based line number, and the matching line — " +
    "so use this instead of reading files one by one (or running shell loops) to locate " +
    "where something is mentioned. Binary files are skipped.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The text to search for. Treated as a literal unless `regex` is true.",
      },
      regex: {
        type: "boolean",
        description: "Interpret `query` as an ECMAScript regular expression. Default false.",
      },
      caseSensitive: {
        type: "boolean",
        description: "Match case exactly. Default false (case-insensitive).",
      },
      prefix: {
        type: "string",
        description: "Only search files whose path starts with this prefix.",
      },
      filesOnly: {
        type: "boolean",
        description:
          "Return only {path, matches} per file instead of individual lines — cheapest " +
          "way to find which files mention the query. Default false.",
      },
      maxResults: {
        type: "number",
        description: `Cap on returned matching lines (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS}).`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

const ATTACHMENT_READ_DEFINITION = {
  name: "attachment_read",
  description:
    "Read one attached file by its exact inventory path. Text files return their content; " +
    "images and PDFs return provider-native visual/document blocks. Video content cannot be " +
    "transported on this connection — reason from its file name, label, and note instead.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Exact absolute path from the attachment inventory.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

// ---------------------------------------------------------------------------
// Manifests (static metadata for the broker)
// ---------------------------------------------------------------------------

export const ATTACHMENT_LIST_MANIFEST: HostToolManifest = {
  toolId: "attachment_list",
  displayName: "Attachment List",
  operations: ["attachment.list"],
  risk: "low",
  defaultEnabled: true,
  definition: ATTACHMENT_LIST_DEFINITION,
};

export const ATTACHMENT_READ_MANIFEST: HostToolManifest = {
  toolId: "attachment_read",
  displayName: "Attachment Read",
  operations: ["attachment.read"],
  risk: "low",
  defaultEnabled: true,
  definition: ATTACHMENT_READ_DEFINITION,
};

export const ATTACHMENT_SEARCH_MANIFEST: HostToolManifest = {
  toolId: "attachment_search",
  displayName: "Attachment Search",
  operations: ["attachment.search"],
  risk: "low",
  defaultEnabled: true,
  definition: ATTACHMENT_SEARCH_DEFINITION,
};

export const ATTACHMENT_MANIFESTS: readonly HostToolManifest[] = [
  ATTACHMENT_LIST_MANIFEST,
  ATTACHMENT_READ_MANIFEST,
  ATTACHMENT_SEARCH_MANIFEST,
];

// ---------------------------------------------------------------------------
// Runtime tool factories
// ---------------------------------------------------------------------------

/**
 * Create executable attachment tools scoped to the given roots.
 * Register these on the tool registry for any chat-completion provider path.
 */
export function attachmentTools(roots: readonly string[]): readonly Tool[] {
  const listTool: Tool = {
    definition: ATTACHMENT_LIST_DEFINITION,
    async execute(input) {
      const args = record(input);
      const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
      const shape = args.shape === "tree" ? "tree" : "flat";
      const files: { path: string; bytes: number }[] = [];
      walkRoots(roots, (path, bytes) => {
        if (prefix !== undefined && !path.startsWith(prefix)) return;
        files.push({ path, bytes });
      });
      if (shape === "flat") return ok({ files: files as unknown as JsonValue });
      // Tree shape: one nested object per root; directories are objects,
      // files map to their byte size. Compact for large stores.
      const trees: Record<string, JsonValue> = {};
      for (const root of roots) {
        const resolvedRoot = resolve(root);
        const tree: Record<string, JsonValue> = {};
        for (const file of files) {
          const rel = relative(resolvedRoot, resolve(file.path));
          if (rel.startsWith("..") || isAbsolute(rel)) continue;
          const segments = rel.split(/[\\/]/);
          let node = tree;
          for (const segment of segments.slice(0, -1)) {
            const child = node[segment];
            if (typeof child === "object" && child !== null && !Array.isArray(child)) {
              node = child as Record<string, JsonValue>;
            } else {
              const created: Record<string, JsonValue> = {};
              node[segment] = created;
              node = created;
            }
          }
          node[segments[segments.length - 1]!] = file.bytes;
        }
        if (Object.keys(tree).length > 0) trees[resolvedRoot] = tree;
      }
      return ok({ roots: trees });
    },
  };

  const searchTool: Tool = {
    definition: ATTACHMENT_SEARCH_DEFINITION,
    async execute(input) {
      const args = record(input);
      const query = typeof args.query === "string" ? args.query : "";
      if (query.length === 0) {
        return refusal("attachment_search requires a non-empty string `query`.");
      }
      const caseSensitive = args.caseSensitive === true;
      const filesOnly = args.filesOnly === true;
      const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
      const maxResults = Math.min(
        MAX_SEARCH_RESULTS,
        typeof args.maxResults === "number" && Number.isFinite(args.maxResults) && args.maxResults >= 1
          ? Math.floor(args.maxResults)
          : DEFAULT_SEARCH_RESULTS,
      );
      let pattern: RegExp;
      try {
        pattern =
          args.regex === true
            ? new RegExp(query, caseSensitive ? "" : "i")
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
      } catch (error) {
        return refusal(
          `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const matches: { path: string; line: number; text: string }[] = [];
      const perFile = new Map<string, number>();
      let totalMatches = 0;
      let filesSearched = 0;
      const skippedLargeFiles: string[] = [];
      walkRoots(roots, (path, bytes) => {
        if (prefix !== undefined && !path.startsWith(prefix)) return;
        if (bytes > MAX_SEARCH_FILE_BYTES) {
          skippedLargeFiles.push(path);
          return;
        }
        let buffer: Buffer;
        try {
          buffer = readFileSync(path);
        } catch {
          return;
        }
        if (!isSearchableText(path, buffer)) return;
        filesSearched += 1;
        const lines = buffer.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          if (!pattern.test(line)) continue;
          totalMatches += 1;
          perFile.set(path, (perFile.get(path) ?? 0) + 1);
          if (!filesOnly && matches.length < maxResults) {
            const at = line.search(pattern);
            const start = line.length <= MAX_MATCH_LINE_CHARS
              ? 0
              : Math.max(0, Math.min(at - 80, line.length - MAX_MATCH_LINE_CHARS));
            const text =
              line.length <= MAX_MATCH_LINE_CHARS
                ? line
                : `${start > 0 ? "…" : ""}${line.slice(start, start + MAX_MATCH_LINE_CHARS)}…`;
            matches.push({ path, line: index + 1, text });
          }
        }
      });
      return ok({
        ...(filesOnly
          ? {}
          : {
              matches: matches as unknown as JsonValue,
              truncated: totalMatches > matches.length,
            }),
        files: [...perFile.entries()].map(([path, count]) => ({
          path,
          matches: count,
        })) as unknown as JsonValue,
        totalMatches,
        filesSearched,
        ...(skippedLargeFiles.length > 0
          ? { skippedLargeFiles: skippedLargeFiles as unknown as JsonValue }
          : {}),
      });
    },
  };

  const readTool: Tool = {
    definition: ATTACHMENT_READ_DEFINITION,
    async execute(input) {
      const path =
        typeof input === "object" && input !== null && !Array.isArray(input) &&
        typeof (input as { path?: JsonValue }).path === "string"
          ? (input as { path: string }).path
          : undefined;
      if (!path) return refusal("attachment_read requires a string `path`.");
      if (!insideRoots(roots, path)) {
        return refusal(
          "This path is outside the submission's attachment store and cannot be read.",
        );
      }
      let stat;
      try {
        stat = statSync(path);
      } catch {
        return refusal("No attached file exists at this exact path.");
      }
      if (!stat.isFile()) {
        return refusal("This path is not a file; list the inventory for exact file paths.");
      }

      const ext = extname(path).toLowerCase();
      const imageMediaType = IMAGE_MEDIA_TYPES[ext];
      if (imageMediaType) {
        if (stat.size > MAX_IMAGE_BYTES) {
          return refusal("This image exceeds the provider's image size limit.");
        }
        const data = readFileSync(path).toString("base64");
        return {
          output: `image ${path} (${imageMediaType}, ${stat.size} bytes)`,
          blocks: [
            {
              type: "image" as const,
              source: { kind: "base64" as const, mediaType: imageMediaType, data },
            },
          ],
        };
      }
      if (ext === ".pdf") {
        const data = readFileSync(path).toString("base64");
        return {
          output: `PDF ${path} (${stat.size} bytes)`,
          blocks: [
            {
              type: "document" as const,
              source: {
                kind: "base64" as const,
                mediaType: "application/pdf" as const,
                data,
              },
              title: basename(path),
            },
          ],
        };
      }
      if ([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv"].includes(ext)) {
        return refusal(
          "Video content is not machine-readable here; use the file's name, label, and note.",
        );
      }

      const buffer = readFileSync(path);
      if (!TEXT_EXTENSIONS.has(ext) && looksBinary(buffer)) {
        return refusal("This file is binary and cannot be shown as text.");
      }
      const text = buffer.toString("utf8");
      if (text.length > MAX_TEXT_CHARS) {
        return ok(
          `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated: showing the first ${MAX_TEXT_CHARS} of ${text.length} characters]`,
        );
      }
      return ok(text);
    },
  };

  return [listTool, readTool, searchTool];
}

export const ATTACHMENT_TOOL_NAMES = [
  "attachment_list",
  "attachment_read",
  "attachment_search",
] as const;
