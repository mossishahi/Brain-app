/**
 * TaxonomyAccess implementations for the worker.
 *
 * - RegistryTaxonomyService: the production path — every call is an MCP tool
 *   round-trip to the Brain Registry's live shared store, so sequential calls
 *   (this user's or anyone else's) always see the latest committed revision.
 * - LocalTaxonomyService: the no-registry fallback (local --content-dir runs,
 *   offline smoke tests): exact name/alias matching and candidate search over
 *   the bundle's seed catalog, with suggestions appended to a per-run JSONL.
 *   Deliberately read-only over the seed — a local run cannot mutate the
 *   shared reference, it can only record what it would have suggested.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  TaxonomyAccess,
  TaxonomyNodePosition,
  TaxonomyResolveResult,
  TaxonomySuggestionEntry,
  TaxonomySuggestionReceipt,
  TaxonomyTreeExport,
} from "@brainstorm-agentic/core";
import type { ContentRegistryClient } from "@brainstorm-agentic/registry-client";

// ---------------------------------------------------------------------------
// Remote: the registry's taxonomy tools
// ---------------------------------------------------------------------------

export class RegistryTaxonomyService implements TaxonomyAccess {
  constructor(private readonly client: ContentRegistryClient) {}

  async resolve(query: string, optionLimit?: number): Promise<TaxonomyResolveResult> {
    return (await this.client.callTool("taxonomy_resolve", {
      query,
      ...(optionLimit !== undefined ? { optionLimit } : {}),
    })) as TaxonomyResolveResult;
  }

  async tree(root?: string): Promise<TaxonomyTreeExport> {
    return (await this.client.callTool("taxonomy_tree", {
      ...(root !== undefined ? { root } : {}),
    })) as TaxonomyTreeExport;
  }

  async suggest(
    entries: readonly TaxonomySuggestionEntry[],
    submittedBy?: string,
  ): Promise<TaxonomySuggestionReceipt> {
    return (await this.client.callTool("taxonomy_suggest", {
      entries: entries.map((entry) => ({
        term: entry.term,
        kind: entry.kind,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      })),
      ...(submittedBy !== undefined ? { submittedBy } : {}),
    })) as TaxonomySuggestionReceipt;
  }
}

// ---------------------------------------------------------------------------
// Local fallback: the bundle's seed catalog
// ---------------------------------------------------------------------------

type Level = "domain" | "field" | "subfield" | "topic";
const LEVELS: readonly Level[] = ["domain", "field", "subfield", "topic"];

interface SeedNode {
  readonly id: string;
  readonly level: Level;
  readonly name: string;
  readonly parent?: string;
  readonly aliases?: readonly string[];
  readonly source?: string;
}

const NOISE_WORDS = new Set(["advanced", "advancements", "advancement"]);
const PREPOSITIONS = new Set([
  "in", "on", "at", "of", "for", "with", "to", "from", "by", "into",
  "onto", "over", "under", "between", "among", "across", "through", "via", "about", "against",
]);
const STRUCTURAL_WORDS = new Set(["a", "an", "the", "and", "or", "as", "its", "their"]);

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stem(word: string): string {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function tokens(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

export class LocalTaxonomyService implements TaxonomyAccess {
  private readonly revision: number;
  private readonly byId = new Map<string, SeedNode>();
  private readonly byName = new Map<string, SeedNode>();
  private readonly byAlias = new Map<string, SeedNode>();
  private readonly children = new Map<string, SeedNode[]>();
  private readonly words = new Map<string, SeedNode[]>();
  private readonly domains: SeedNode[] = [];

  constructor(
    seedPath: string,
    private readonly suggestionsFile: string,
  ) {
    if (!existsSync(seedPath)) {
      throw new Error(`taxonomy seed not found at "${seedPath}"`);
    }
    const doc = JSON.parse(readFileSync(seedPath, "utf8")) as {
      revision?: number;
      nodes: SeedNode[];
    };
    this.revision = doc.revision ?? 1;
    for (const node of doc.nodes) {
      this.byId.set(node.id, node);
      this.byName.set(normalize(node.name), node);
      for (const alias of node.aliases ?? []) this.byAlias.set(normalize(alias), node);
      if (node.parent) {
        const siblings = this.children.get(node.parent);
        if (siblings) siblings.push(node);
        else this.children.set(node.parent, [node]);
      } else if (node.level === "domain") {
        this.domains.push(node);
      }
      for (const word of new Set(tokens(node.name).map(stem))) {
        const bucket = this.words.get(word);
        if (bucket) bucket.push(node);
        else this.words.set(word, [node]);
      }
    }
    this.domains.sort((a, b) => a.name.localeCompare(b.name));
  }

  private position(node: SeedNode, matchedOn: "name" | "alias", alias?: string): TaxonomyNodePosition {
    const chain: SeedNode[] = [];
    let cursor: SeedNode | undefined = node;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.parent ? this.byId.get(cursor.parent) : undefined;
    }
    const named = (level: Level): string | undefined =>
      chain.find((entry) => entry.level === level)?.name;
    return {
      id: node.id,
      name: node.name,
      level: node.level,
      path: chain.map((entry) => entry.name),
      ...(named("domain") ? { domain: named("domain") } : {}),
      ...(named("field") ? { field: named("field") } : {}),
      ...(named("subfield") ? { subfield: named("subfield") } : {}),
      ...(named("topic") ? { topic: named("topic") } : {}),
      matchedOn,
      ...(alias !== undefined ? { matchedAlias: alias } : {}),
    };
  }

  async resolve(query: string, optionLimit = 25): Promise<TaxonomyResolveResult> {
    const needle = normalize(query);
    const byName = needle ? this.byName.get(needle) : undefined;
    if (byName) {
      return { query, found: true, revision: this.revision, position: this.position(byName, "name") };
    }
    const byAlias = needle ? this.byAlias.get(needle) : undefined;
    if (byAlias) {
      return { query, found: true, revision: this.revision, position: this.position(byAlias, "alias", query) };
    }
    const beta: string[] = [];
    for (const word of tokens(query)) {
      if (NOISE_WORDS.has(word) || PREPOSITIONS.has(word) || STRUCTURAL_WORDS.has(word)) continue;
      if (!beta.includes(word)) beta.push(word);
    }
    const tally = new Map<string, { node: SeedNode; hits: number }>();
    for (const word of beta) {
      for (const node of this.words.get(stem(word)) ?? []) {
        const entry = tally.get(node.id);
        if (entry) entry.hits += 1;
        else tally.set(node.id, { node, hits: 1 });
      }
    }
    const ranked = [...tally.values()].sort(
      (a, b) =>
        b.hits - a.hits ||
        a.node.name.length - b.node.name.length ||
        a.node.name.localeCompare(b.node.name),
    );
    const options = ranked
      .slice(0, optionLimit)
      .map((candidate) => candidate.node.name)
      .sort((a, b) => a.localeCompare(b));
    return {
      query,
      found: false,
      status: "NA",
      revision: this.revision,
      beta,
      options,
      total: ranked.length,
    };
  }

  async tree(root?: string): Promise<TaxonomyTreeExport> {
    const lines: string[] = [];
    let count = 0;
    const walk = (node: SeedNode, depth: number): void => {
      lines.push(`${"  ".repeat(depth)}${node.name}`);
      count += 1;
      for (const child of [...(this.children.get(node.id) ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        walk(child, depth + 1);
      }
    };
    if (root) {
      const node =
        this.byId.get(root) ?? this.byName.get(normalize(root)) ?? this.byAlias.get(normalize(root));
      if (!node) throw new Error(`no taxonomy node matches "${root}"`);
      walk(node, 0);
    } else {
      for (const domain of this.domains) walk(domain, 0);
    }
    return { revision: this.revision, nodeCount: count, outline: lines.join("\n") };
  }

  async suggest(
    entries: readonly TaxonomySuggestionEntry[],
    submittedBy?: string,
  ): Promise<TaxonomySuggestionReceipt> {
    const receipt = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      revision: this.revision,
      queued: entries.length,
    };
    mkdirSync(dirname(this.suggestionsFile), { recursive: true });
    appendFileSync(
      this.suggestionsFile,
      `${JSON.stringify({ ...receipt, submittedBy: submittedBy ?? "", entries })}\n`,
      "utf8",
    );
    return receipt;
  }
}

/** The bundle's seed catalog inside a local content directory. */
export function localTaxonomySeedPath(contentDir: string): string {
  return join(contentDir, "catalog", "taxonomy.json");
}
