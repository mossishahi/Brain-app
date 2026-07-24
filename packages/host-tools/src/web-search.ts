/**
 * Extension interfaces for future web-search host tools.
 * These are NOT implemented in this package yet — they define the contract
 * for backends that can be plugged in later.
 */
import type { HostToolManifest } from "@brainstorm-agentic/core";

// ---------------------------------------------------------------------------
// Search backend interface
// ---------------------------------------------------------------------------

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published?: string;
  readonly source?: string;
}

export interface SearchBackend {
  search(query: string, options: { maxResults: number; signal?: AbortSignal }): Promise<readonly SearchHit[]>;
}

// ---------------------------------------------------------------------------
// Manifests (static; tools are not yet executable)
// ---------------------------------------------------------------------------

export const WEB_SEARCH_MANIFEST: HostToolManifest = {
  toolId: "web_search",
  displayName: "Web Search",
  operations: ["web.search"],
  risk: "medium",
  defaultEnabled: false,
  definition: {
    name: "web_search",
    description:
      "Search the public web or scholarly indexes. Returns a list of results with title, URL, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return.",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const WEB_FETCH_MANIFEST: HostToolManifest = {
  toolId: "web_fetch",
  displayName: "Web Fetch",
  operations: ["web.fetch"],
  risk: "medium",
  defaultEnabled: false,
  definition: {
    name: "web_fetch",
    description:
      "Fetch and extract text content from a public http(s) URL. Returns the main text truncated to a configurable limit.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL to retrieve." },
        max_chars: {
          type: "integer",
          description: "Maximum characters to return.",
          minimum: 1000,
          maximum: 48000,
          default: 12000,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const WEB_SEARCH_MANIFESTS: readonly HostToolManifest[] = [
  WEB_SEARCH_MANIFEST,
  WEB_FETCH_MANIFEST,
];
