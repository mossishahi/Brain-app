/**
 * Provider-neutral attachment tools satisfying the `attachment-access` capability.
 *
 * - `attachment_list` returns the inventory under the job's attachment store.
 * - `attachment_read` returns one file: text as text, images/PDFs as
 *   provider-neutral rich blocks (base64), and an honest refusal for media
 *   this transport cannot carry.
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

function ok(output: JsonValue) {
  return { output };
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
    "Optionally filter by a path prefix.",
  inputSchema: {
    type: "object",
    properties: {
      prefix: {
        type: "string",
        description: "Only return files whose path starts with this prefix.",
      },
    },
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

export const ATTACHMENT_MANIFESTS: readonly HostToolManifest[] = [
  ATTACHMENT_LIST_MANIFEST,
  ATTACHMENT_READ_MANIFEST,
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
      const prefix =
        typeof input === "object" && input !== null && !Array.isArray(input) &&
        typeof (input as { prefix?: JsonValue }).prefix === "string"
          ? ((input as { prefix: string }).prefix)
          : undefined;
      const files: { path: string; bytes: number }[] = [];
      const walk = (dir: string): void => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile()) {
            if (prefix !== undefined && !path.startsWith(prefix)) continue;
            files.push({ path, bytes: statSync(path).size });
          }
        }
      };
      for (const root of roots) walk(root);
      return ok({ files: files as unknown as JsonValue });
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

  return [listTool, readTool];
}

export const ATTACHMENT_TOOL_NAMES = ["attachment_list", "attachment_read"] as const;
