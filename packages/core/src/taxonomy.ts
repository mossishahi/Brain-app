/**
 * Access contract for the SHARED scientific taxonomy served by the Brain
 * Registry (domain > field > subfield > topic; one live store, monotonic
 * revisions, updated by many users).
 *
 * Reads answer from the latest committed revision and carry it. `suggest`
 * queues a run's placement decisions on the registry's append-only queue —
 * recorded, never applied here; suggestion processing is a separate
 * server-side concern.
 *
 * Implementations: the worker's remote client (MCP tools on the registry) and
 * a local fallback over the bundle's seed catalog for offline/test runs.
 */

/** A node position in the shared four-level taxonomy. */
export interface TaxonomyNodePosition {
  readonly id: string;
  readonly name: string;
  readonly level: "domain" | "field" | "subfield" | "topic";
  /** Ancestors then self. */
  readonly path: readonly string[];
  readonly domain?: string;
  readonly field?: string;
  readonly subfield?: string;
  readonly topic?: string;
  /** "embedding": an unambiguous semantic auto-match (client-side lane). */
  readonly matchedOn?: "name" | "alias" | "embedding";
  readonly matchedAlias?: string;
}

/** The server-side processor's answer for one query. */
export type TaxonomyResolveResult =
  | {
      readonly query: string;
      readonly found: true;
      readonly revision: number;
      readonly position: TaxonomyNodePosition;
    }
  | {
      readonly query: string;
      readonly found: false;
      readonly status: "NA";
      readonly revision: number;
      /** Meaning-carrying words the candidate search used. */
      readonly beta: readonly string[];
      /** Candidate node NAMES, alphabetized — never scores. */
      readonly options: readonly string[];
      readonly total: number;
    };

export interface TaxonomyTreeExport {
  readonly revision: number;
  readonly nodeCount: number;
  /** Names-only outline; indent depth encodes the level. */
  readonly outline: string;
}

export interface TaxonomySuggestionEntry {
  readonly term: string;
  /** matched | place | already_present | insert | undecided. */
  readonly kind: string;
  readonly detail?: unknown;
}

export interface TaxonomySuggestionReceipt {
  readonly id: string;
  readonly receivedAt: string;
  readonly revision: number;
  readonly queued: number;
}

/**
 * The node-embedding index of one taxonomy revision, as served by the
 * registry (or computed locally over the bundle seed for offline runs):
 * node metadata parallel to L2-normalized vectors, plus the embedder
 * manifest a client must verify its own implementation against before
 * trusting its query vectors (see verifyEmbedder in embedder.ts).
 */
export interface TaxonomyEmbeddings {
  readonly revision: number;
  readonly embedder: import("./embedder.js").EmbedderManifest;
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly level: "domain" | "field" | "subfield" | "topic";
    readonly parent?: string;
  }>;
  readonly vectors: ReadonlyArray<readonly number[]>;
}

export interface TaxonomyAccess {
  resolve(query: string, optionLimit?: number): Promise<TaxonomyResolveResult>;
  tree(root?: string): Promise<TaxonomyTreeExport>;
  suggest(
    entries: readonly TaxonomySuggestionEntry[],
    submittedBy?: string,
  ): Promise<TaxonomySuggestionReceipt>;
  /**
   * The node-embedding index of the current revision. Optional: transports
   * that cannot serve it (older registries) simply leave the semantic lane
   * off — matching then runs exactly as before the lane existed.
   */
  embeddings?(): Promise<TaxonomyEmbeddings | undefined>;
}
