/**
 * The deterministic activities of the decomposer split, built over an injected
 * TaxonomyAccess (the shared live taxonomy on the Brain Registry, or a local
 * fallback for offline runs). No model is ever called here.
 *
 * - `taxonomy.match` — the HYBRID matching lane per pool member:
 *   1. PILLARS (decide): exact name/alias resolve, untouchable.
 *   2. EMBEDDINGS (propose): the registry-served node-vector index scores
 *      every still-unmatched term (cosine + a small active-region boost from
 *      the classifier's facets and the exact-match landings); an unambiguous
 *      score above the served tauMatch auto-matches, everything else gets a
 *      scored candidate list.
 *   3. The PLACER (referee, next node) receives the unmatched projection
 *      with those candidates attached.
 *   The lane is fail-safe: no served index, or a local embedder that cannot
 *   reproduce the served verification vectors, turns it off and the match
 *   behaves exactly as before the lane existed.
 * - `taxonomy.suggest` — submit a copy of the run's decision for EVERY pool
 *   member to the registry's append-only suggestion queue (recorded, never
 *   applied) and return the receipt. Terms that matched NO current node are
 *   queued as place-anchored INSERT suggestions carrying their nearest-node
 *   evidence, so review walks the tree instead of the submission files.
 * - `experts.bridge` — TEMPORARY: fold matched positions and placement
 *   decisions into the legacy experts tree so panel selection and everything
 *   downstream keep working until the pool-based seating design lands.
 */
import type {
  JsonObject,
  JsonValue,
  TaxonomyAccess,
  TaxonomyEmbeddings,
  TaxonomyNodePosition,
  TaxonomySuggestionEntry,
} from "@brainstorm-agentic/core";
import {
  cosine,
  facetEmbedding,
  termEmbedding,
  verifyEmbedder,
} from "@brainstorm-agentic/core";

import type { DeterministicActivityHandler } from "./compiler.js";

interface PoolMemberInput {
  readonly term: string;
  readonly count: number;
  /** Input-topic relevance in [0,1], judged and audited by the pool builder. */
  readonly relevance?: number;
  readonly variants: readonly string[];
  readonly origins: readonly JsonValue[];
}

/** Tolerates pre-relevance pool artifacts (old runs resumed under new code). */
function relevanceOf(member: PoolMemberInput): number {
  return typeof member.relevance === "number" ? member.relevance : 0;
}

interface MatchedMember extends PoolMemberInput {
  readonly matched: boolean;
  readonly position?: TaxonomyNodePosition;
  readonly options: readonly string[];
  /** Raw cosine of an embedding auto-match. */
  readonly matchScore?: number;
  /** Scored nearest nodes of an unmatched member (semantic lane on). */
  readonly candidates?: ReadonlyArray<{
    readonly name: string;
    readonly level: string;
    readonly path: readonly string[];
    readonly score: number;
  }>;
  /** The original compound pool term this half was split from, if any. */
  readonly splitFrom?: string;
}

interface PlacementDecisionInput {
  readonly term: string;
  readonly outcome: "place" | "already_present" | "undecidable";
  readonly name?: string;
  readonly parent?: string;
  readonly aliases?: readonly string[];
  readonly node?: string;
  readonly reason: string;
}

function asObject(value: JsonValue | undefined, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object`);
  }
  return value as JsonObject;
}

function asArray(value: JsonValue | undefined, what: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
  return value;
}

function positiveInteger(value: JsonValue | undefined, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${what} must be a positive integer`);
  }
  return value;
}

/**
 * Lead words of organization/institution names ("Center for X", "Institute
 * for Y") that make an "<A> for <B>" split produce a meaningless first half.
 * Deliberately small and conservative — false negatives (a real compound
 * term that isn't split) are harmless; the guard only prevents obviously
 * useless splits.
 */
const COMPOUND_SPLIT_GUARD_WORDS = new Set([
  "center", "centre", "institute", "program", "programme", "department",
  "lab", "laboratory", "group", "society", "foundation", "office",
  "council", "committee", "division", "school", "academy", "consortium",
  "association", "company", "corporation",
]);

/**
 * Splits a pool term shaped "<A> for <B>" into its two halves — a method
 * or object (A) and the domain or purpose it is applied to (B) — when both
 * halves look like real, standalone phrases rather than an organization
 * name that happens to contain "for" ("Center for Computational Biology").
 * Only ONE split point is ever tried: the first standalone " for " in the
 * term, case-insensitive, on word boundaries.
 */
export function splitCompoundTerm(term: string): readonly [string, string] | undefined {
  const match = term.match(/^(.+?)\s+for\s+(.+)$/i);
  if (!match) return undefined;
  const a = match[1]!.trim();
  const b = match[2]!.trim();
  if (!a || !b) return undefined;
  const leadWord = a.split(/\s+/)[0]?.toLowerCase();
  if (leadWord && COMPOUND_SPLIT_GUARD_WORDS.has(leadWord)) return undefined;
  return [a, b];
}

/** Strip a resolve position to the artifact's schema (no revision echo inside). */
function positionArtifact(position: TaxonomyNodePosition): JsonObject {
  return {
    id: position.id,
    name: position.name,
    level: position.level,
    path: [...position.path],
    ...(position.domain ? { domain: position.domain } : {}),
    ...(position.field ? { field: position.field } : {}),
    ...(position.subfield ? { subfield: position.subfield } : {}),
    ...(position.topic ? { topic: position.topic } : {}),
    ...(position.matchedOn ? { matchedOn: position.matchedOn } : {}),
    ...(position.matchedAlias ? { matchedAlias: position.matchedAlias } : {}),
  } as JsonObject;
}

/** The levels in order, for path-derived positions of embedding matches. */
const PATH_LEVELS = ["domain", "field", "subfield", "topic"] as const;

/** One scored candidate node attached to an unmatched member. */
interface CandidateArtifact {
  readonly name: string;
  readonly level: (typeof PATH_LEVELS)[number];
  readonly path: readonly string[];
  readonly score: number;
}

/** How many scored candidates ride to the placer and the suggestion queue. */
const MAX_CANDIDATES = 5;

/**
 * The run's semantic matcher over the served node-vector index: raw cosine
 * ordering with a small active-region boost (facet heat + exact-match
 * pillars), thresholds exactly as served in the embedder manifest.
 */
class SemanticIndex {
  private readonly paths: ReadonlyArray<readonly string[]>;
  private readonly heat = new Map<string, number>();
  private readonly lambda: number;

  constructor(private readonly index: TaxonomyEmbeddings) {
    const byId = new Map(index.nodes.map((node) => [node.id, node]));
    this.paths = index.nodes.map((node) => {
      const names: string[] = [];
      let cursor: (typeof index.nodes)[number] | undefined = node;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        names.unshift(cursor.name);
        cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
      }
      return names;
    });
    this.lambda = index.embedder.thresholds.lambda;
  }

  /** Region keys of one node: its field and subfield ancestor names. */
  private regions(nodeIndex: number): string[] {
    const path = this.paths[nodeIndex]!;
    return [path[1], path[2]].filter((name): name is string => typeof name === "string");
  }

  /** Raise the active-region heat under a landing path (facet or pillar). */
  warm(path: readonly string[], value: number): void {
    for (const key of [path[1], path[2]]) {
      if (typeof key !== "string") continue;
      this.heat.set(key, Math.max(this.heat.get(key) ?? 0, value));
    }
  }

  /** Warm regions from the classifier's facets (name+statement vectors). */
  warmFromFacets(facets: ReadonlyArray<{ name: string; statement: string; relevance: number }>): void {
    for (const facet of facets) {
      const vector = facetEmbedding(facet.name, facet.statement);
      for (let i = 0; i < this.index.nodes.length; i += 1) {
        const score = cosine(vector, this.index.vectors[i]!) * facet.relevance;
        if (score <= 0) continue;
        for (const key of this.regions(i)) {
          this.heat.set(key, Math.max(this.heat.get(key) ?? 0, score));
        }
      }
    }
  }

  /**
   * Rank every node for one term: ordered by cosine plus the region boost;
   * thresholds are tested downstream against the RAW cosine (the boost
   * orders and disambiguates, it never fakes similarity).
   */
  rank(term: string, variants: readonly string[]): Array<{
    readonly nodeIndex: number;
    readonly cos: number;
    readonly boosted: number;
  }> {
    const query = termEmbedding(term, variants);
    const scored = this.index.nodes.map((_, nodeIndex) => {
      const cos = cosine(query, this.index.vectors[nodeIndex]!);
      const regionHeat = Math.max(
        0,
        ...this.regions(nodeIndex).map((key) => this.heat.get(key) ?? 0),
      );
      return { nodeIndex, cos, boosted: cos + this.lambda * regionHeat };
    });
    scored.sort((a, b) => b.boosted - a.boosted || b.cos - a.cos || a.nodeIndex - b.nodeIndex);
    return scored;
  }

  candidate(entry: { nodeIndex: number; cos: number }): CandidateArtifact {
    const node = this.index.nodes[entry.nodeIndex]!;
    return {
      name: node.name,
      level: node.level,
      path: this.paths[entry.nodeIndex]!,
      score: Math.round(entry.cos * 10000) / 10000,
    };
  }

  /** A full position artifact for an embedding auto-match. */
  position(nodeIndex: number): JsonObject {
    const node = this.index.nodes[nodeIndex]!;
    const path = this.paths[nodeIndex]!;
    const named = (level: (typeof PATH_LEVELS)[number]): string | undefined =>
      path[PATH_LEVELS.indexOf(level)];
    return {
      id: node.id,
      name: node.name,
      level: node.level,
      path: [...path],
      ...(named("domain") ? { domain: named("domain") } : {}),
      ...(named("field") ? { field: named("field") } : {}),
      ...(named("subfield") ? { subfield: named("subfield") } : {}),
      ...(named("topic") ? { topic: named("topic") } : {}),
      matchedOn: "embedding",
    } as JsonObject;
  }

  get thresholds(): TaxonomyEmbeddings["embedder"]["thresholds"] {
    return this.index.embedder.thresholds;
  }
}

/** How many subfield branches the placer outline may expand in full. */
const MAX_OUTLINE_BRANCHES = 60;
/** Options resolved per member (and in total) when candidates are absent. */
const MAX_OPTION_ANCHORS_PER_MEMBER = 8;
const MAX_OPTION_ANCHORS_TOTAL = 80;

/** One parsed line of the registry's indented tree outline. */
interface ParsedOutlineNode {
  readonly name: string;
  readonly children: ParsedOutlineNode[];
}

/** Parses the tree outline ("  " per depth level) into a node forest. */
function parseTreeOutline(outline: string): ParsedOutlineNode[] {
  const roots: ParsedOutlineNode[] = [];
  const stack: ParsedOutlineNode[] = [];
  for (const line of outline.split("\n")) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    const depth = Math.floor(indent / 2);
    const node: ParsedOutlineNode = { name: line.trim(), children: [] };
    stack.length = Math.min(stack.length, depth);
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }
  return roots;
}

/** The anchor set the outline expands: field names and field|subfield pairs. */
interface OutlineAnchors {
  readonly fields: ReadonlySet<string>;
  readonly branches: ReadonlySet<string>;
}

function anchorsFromPaths(paths: ReadonlyArray<readonly string[]>): OutlineAnchors {
  const fields = new Set<string>();
  const branches = new Set<string>();
  for (const path of paths) {
    const field = path[1];
    const subfield = path[2];
    if (typeof field !== "string") continue;
    fields.add(field);
    if (typeof subfield !== "string") continue;
    if (branches.size >= MAX_OUTLINE_BRANCHES) continue;
    branches.add(`${field}|${subfield}`);
  }
  return { fields, branches };
}

/** The candidate landing paths of the unmatched members, in given order. */
function candidatePaths(unmatched: readonly JsonValue[]): ReadonlyArray<readonly string[]> {
  const paths: Array<readonly string[]> = [];
  for (const raw of unmatched) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const candidates = (raw as JsonObject).candidates;
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const path = (candidate as JsonObject).path;
      if (Array.isArray(path) && path.every((name) => typeof name === "string")) {
        paths.push(path as readonly string[]);
      }
    }
  }
  return paths;
}

/**
 * Fallback anchors when the semantic lane was off: the word-overlap `options`
 * are existing node NAMES, so a bounded number of deterministic resolve
 * round-trips recovers their positions.
 */
async function optionPaths(
  taxonomy: TaxonomyAccess,
  unmatched: readonly JsonValue[],
): Promise<ReadonlyArray<readonly string[]>> {
  const paths: Array<readonly string[]> = [];
  let resolved = 0;
  for (const raw of unmatched) {
    if (resolved >= MAX_OPTION_ANCHORS_TOTAL) break;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const options = (raw as JsonObject).options;
    if (!Array.isArray(options)) continue;
    for (const option of options.slice(0, MAX_OPTION_ANCHORS_PER_MEMBER)) {
      if (resolved >= MAX_OPTION_ANCHORS_TOTAL) break;
      if (typeof option !== "string") continue;
      resolved += 1;
      try {
        const result = await taxonomy.resolve(option);
        if (result.found) paths.push(result.position.path);
      } catch {
        // A failed option lookup contributes no anchor; the skeleton stands.
      }
    }
  }
  return paths;
}

/**
 * The pruned taxonomy outline the placer reads instead of the whole tree
 * (~50k tokens): always the complete domain/field skeleton, plus — around
 * the unmatched members' candidate landings — the touched fields' subfield
 * lists and the touched subfields' full topic lists (the sibling context the
 * placer's own rules demand). Every cut is marked inline with the count and
 * the fact that the branch can be fetched by name, so the honest-exit and
 * "attach higher" moves stay possible. Deterministic over the run's pinned
 * taxonomy: a resume or retry rebuilds the identical text.
 */
export async function buildPlacerOutline(
  taxonomy: TaxonomyAccess,
  unmatched: readonly JsonValue[],
): Promise<string> {
  let tree: { revision: number; nodeCount: number; outline: string };
  try {
    tree = await taxonomy.tree();
  } catch {
    // Fail open: the placer then falls back to reading the tree itself
    // through its taxonomy-access capability, exactly as before the outline.
    return OUTLINE_UNAVAILABLE;
  }
  const fromCandidates = candidatePaths(unmatched);
  const anchorPaths =
    fromCandidates.length > 0 ? fromCandidates : await optionPaths(taxonomy, unmatched);
  const anchors = anchorsFromPaths(anchorPaths);

  // A broad submission can anchor in many topic-heavy subfields at once, and
  // the expansions then add up. The artifact schema caps this field, so an
  // outline over the cap would fail the deterministic activity that renders
  // it — killing the run, and killing every resume with it, because the
  // activity's output is journaled. Nothing about the placer's job requires
  // the widest possible outline, so the render degrades instead: fewer
  // expansions, then none, then the same fetch-it-yourself note a missing
  // tree produces. Every level names its cuts, so what is dropped stays
  // reachable through the placer's taxonomy-access capability.
  for (const level of [anchors, topicsCut(anchors), NOTHING_EXPANDED]) {
    const text = renderOutline(tree, level);
    if (text.length <= MAX_OUTLINE_CHARS) return text;
  }
  return OUTLINE_UNAVAILABLE;
}

/**
 * Expansion budget for the rendered outline, under the artifact schema's own
 * ceiling with room to spare. It is not a token budget — a normal outline is
 * a small fraction of this — it is the point past which rendering more would
 * fail the run instead of informing the placer.
 */
const MAX_OUTLINE_CHARS = 110_000;

const OUTLINE_UNAVAILABLE =
  "Shared taxonomy — outline unavailable for this run; fetch the tree " +
  "through your taxonomy-access capability instead.";

interface OutlineAnchors {
  readonly fields: ReadonlySet<string>;
  readonly branches: ReadonlySet<string>;
}

/** The same anchors with every topic list cut back to a count. */
function topicsCut(anchors: OutlineAnchors): OutlineAnchors {
  return { fields: anchors.fields, branches: new Set<string>() };
}

/** The bare domain/field skeleton: every branch cut, every cut counted. */
const NOTHING_EXPANDED: OutlineAnchors = {
  fields: new Set<string>(),
  branches: new Set<string>(),
};

function renderOutline(
  tree: { revision: number; nodeCount: number; outline: string },
  anchors: OutlineAnchors,
): string {
  const lines: string[] = [
    `Shared taxonomy — revision ${tree.revision}, ${tree.nodeCount} nodes. ` +
      'Branches marked "not shown" are cut for brevity: fetch any of them by ' +
      "name through your taxonomy-access capability (subtree fetch), or " +
      "resolve a name directly.",
  ];
  const count = (n: number, unit: string): string =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  for (const domain of parseTreeOutline(tree.outline)) {
    lines.push(domain.name);
    for (const field of domain.children) {
      if (!anchors.fields.has(field.name)) {
        lines.push(
          field.children.length > 0
            ? `  ${field.name} (${count(field.children.length, "subfield")} — not shown)`
            : `  ${field.name}`,
        );
        continue;
      }
      lines.push(`  ${field.name}`);
      for (const subfield of field.children) {
        if (!anchors.branches.has(`${field.name}|${subfield.name}`)) {
          lines.push(
            subfield.children.length > 0
              ? `    ${subfield.name} (${count(subfield.children.length, "topic")} — not shown)`
              : `    ${subfield.name}`,
          );
          continue;
        }
        lines.push(`    ${subfield.name}`);
        for (const topic of subfield.children) {
          lines.push(`      ${topic.name}`);
        }
      }
    }
  }
  return lines.join("\n");
}

/** The classifier's facets out of an optionally bound classification. */
function facetsOf(
  classification: JsonValue | undefined,
): Array<{ name: string; statement: string; relevance: number }> {
  if (typeof classification !== "object" || classification === null || Array.isArray(classification)) {
    return [];
  }
  const embeddingInput = (classification as JsonObject).embeddingInput;
  if (typeof embeddingInput !== "object" || embeddingInput === null || Array.isArray(embeddingInput)) {
    return [];
  }
  const facets = (embeddingInput as JsonObject).facets;
  if (!Array.isArray(facets)) return [];
  return facets.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const facet = raw as JsonObject;
    return typeof facet.name === "string" &&
      typeof facet.statement === "string" &&
      typeof facet.relevance === "number"
      ? [{ name: facet.name, statement: facet.statement, relevance: facet.relevance }]
      : [];
  });
}

export function taxonomyActivities(
  taxonomy: TaxonomyAccess,
): Readonly<Record<string, DeterministicActivityHandler>> {
  const match: DeterministicActivityHandler = async (input) => {
    const pool = asObject(input.pool, "pool");
    const maxMembers = positiveInteger(input.maxMembers, "maxMembers");
    const members = asArray(pool.members, "pool.members").slice(0, maxMembers);

    // The semantic lane: served node vectors + a conformance-verified local
    // embedder, or off (older registry, drifted implementation) — in which
    // case matching behaves exactly as before the lane existed.
    const served = taxonomy.embeddings ? await taxonomy.embeddings() : undefined;
    let semantic: SemanticIndex | undefined;
    let laneReason: string | undefined;
    if (served === undefined) {
      laneReason = "no node-embedding index served for this taxonomy";
    } else if (!verifyEmbedder(served.embedder)) {
      laneReason =
        `local embedder does not reproduce the served "${served.embedder.id}" verification vectors; ` +
        "semantic matching disabled for this run";
    } else {
      semantic = new SemanticIndex(served);
      semantic.warmFromFacets(facetsOf(input.classification));
    }

    // Pass 1 — PILLARS: exact name/alias matches decide, and their landings
    // warm the active regions the embedding pass leans toward.
    let revision = 1;
    interface Pending {
      readonly base: JsonObject;
      readonly options: readonly string[];
    }
    const annotated: (JsonValue | null)[] = [];
    const pending: Array<{ readonly slot: number; readonly entry: Pending }> = [];
    // A split turns 1 pool member into 2 output entries — 1 net entry more
    // than carrying it whole. `members` is already sliced to `maxMembers`
    // above, so `maxMembers - members.length` is exactly the number of
    // splits the WHOLE pass may ever perform without the final output
    // exceeding the declared bound. This is computed once, outside the
    // loop, and decremented on every split actually performed — checking
    // it locally per-iteration against a snapshot of `annotated.length`
    // (the previous approach) only proves THAT split leaves room; it says
    // nothing about the ordinary members still ahead in the loop, each of
    // which pushes unconditionally with no bound check of its own. A global
    // budget is the only way to keep the cumulative total, in any order and
    // across any number of splits, from ever crossing maxMembers.
    let splitBudget = maxMembers - members.length;
    for (const raw of members) {
      const member = asObject(raw, "pool member") as unknown as PoolMemberInput;
      const result = await taxonomy.resolve(member.term);
      revision = Math.max(revision, result.revision);
      const base: JsonObject = {
        term: member.term,
        count: member.count,
        ...(member.relevance !== undefined ? { relevance: member.relevance } : {}),
        variants: [...member.variants] as unknown as JsonValue,
        origins: [...member.origins] as unknown as JsonValue,
      };
      if (result.found) {
        semantic?.warm(result.position.path, relevanceOf(member));
        annotated.push({
          ...base,
          matched: true,
          position: positionArtifact(result.position),
          options: [],
        } as unknown as JsonValue);
        continue;
      }

      // The whole term did not resolve. Before carrying it through as one
      // atomic unit, check whether it is a compound "<A> for <B>" term glued
      // from two distinct concepts (one person's stated interest, e.g.
      // "Manifold Learning for Network Analysis") — split it so BOTH halves
      // get their own independent shot at landing, each carrying the exact
      // same count/relevance/origins as the original (real evidence for
      // both), rather than losing one half to a single placement.
      const halves = splitCompoundTerm(member.term);
      if (halves && splitBudget > 0) {
        splitBudget -= 1;
        for (const half of halves) {
          const halfBase: JsonObject = {
            term: half,
            count: member.count,
            ...(member.relevance !== undefined ? { relevance: member.relevance } : {}),
            variants: [half] as unknown as JsonValue,
            origins: [...member.origins] as unknown as JsonValue,
            splitFrom: member.term,
          };
          const halfResult = await taxonomy.resolve(half);
          revision = Math.max(revision, halfResult.revision);
          annotated.push(null);
          if (halfResult.found) {
            semantic?.warm(halfResult.position.path, relevanceOf(member));
            annotated[annotated.length - 1] = {
              ...halfBase,
              matched: true,
              position: positionArtifact(halfResult.position),
              options: [],
            } as unknown as JsonValue;
          } else {
            pending.push({
              slot: annotated.length - 1,
              entry: { base: halfBase, options: halfResult.options },
            });
          }
        }
        continue;
      }

      annotated.push(null);
      pending.push({
        slot: annotated.length - 1,
        entry: { base, options: result.options },
      });
    }

    // Pass 2 — EMBEDDINGS propose: unambiguous scores above the served
    // tauMatch auto-match; everything else carries its scored candidates to
    // the placer (the referee) and onward to the suggestion queue.
    const unmatched: JsonValue[] = [];
    for (const { slot, entry } of pending) {
      const term = entry.base.term as string;
      const variants = entry.base.variants as unknown as readonly string[];
      if (!semantic) {
        const plain = {
          ...entry.base,
          matched: false,
          options: [...entry.options],
        } as unknown as JsonValue;
        annotated[slot] = plain;
        unmatched.push(plain);
        continue;
      }
      const ranked = semantic.rank(term, variants);
      const best = ranked[0];
      const runnerUp = ranked[1];
      const { tauMatch, delta, tauFloor } = semantic.thresholds;
      if (
        best !== undefined &&
        best.cos >= tauMatch &&
        (runnerUp === undefined || best.cos - runnerUp.cos >= delta)
      ) {
        annotated[slot] = {
          ...entry.base,
          matched: true,
          position: semantic.position(best.nodeIndex),
          matchScore: Math.round(best.cos * 10000) / 10000,
          options: [],
        } as unknown as JsonValue;
        continue;
      }
      const candidates =
        best !== undefined && best.cos >= tauFloor
          ? ranked.slice(0, MAX_CANDIDATES).map((entry_) => semantic!.candidate(entry_))
          : ranked.slice(0, 3).map((entry_) => semantic!.candidate(entry_));
      const enriched = {
        ...entry.base,
        matched: false,
        options: [...entry.options],
        candidates: candidates as unknown as JsonValue,
      } as unknown as JsonValue;
      annotated[slot] = enriched;
      unmatched.push(enriched);
    }

    // The placer's pruned reading of the tree, anchored on the unmatched
    // members' candidate landings. Always emitted (the skeleton at minimum),
    // so a workflow that binds it never fails to resolve; bundles that do
    // not bind it simply carry a field nothing reads.
    const placerOutline = await buildPlacerOutline(taxonomy, unmatched);

    return {
      revision,
      members: annotated as JsonValue[],
      unmatched,
      embedding: semantic
        ? { enabled: true, embedderId: served!.embedder.id }
        : { enabled: false, ...(laneReason ? { reason: laneReason } : {}) },
      placerOutline,
    } as unknown as JsonValue;
  };

  const suggest: DeterministicActivityHandler = async (input, context) => {
    const matches = asObject(input.matches, "matches");
    const placements = asObject(input.placements, "placements");
    const maxMembers = positiveInteger(input.maxMembers, "maxMembers");
    const members = asArray(matches.members, "matches.members").slice(0, maxMembers);
    const decisions = asArray(placements.decisions, "placements.decisions").map(
      (raw) => asObject(raw, "placement decision") as unknown as PlacementDecisionInput,
    );
    // Decisions are positional against the run's unmatched members, never
    // keyed by term text: the compiler enforces a strict 1:1, in-order
    // correspondence between `placements.decisions` and `poolMatches.
    // unmatched` on write (see compiler.ts's PLACEMENT_COVERAGE_MISMATCH
    // check). A compound-term split can legally place two members with
    // identical term text side by side — an unrelated standalone member and
    // a compound's half both named e.g. "Manifold Learning" — and a
    // term-keyed map would let the second silently overwrite the first's
    // decision. Advancing a cursor once per unmatched member, in the same
    // order they are encountered below, keeps each member's own decision
    // (or absence of one) correctly attached regardless of duplicate text.
    let nextDecisionIndex = 0;

    const entries: TaxonomySuggestionEntry[] = [];
    for (const raw of members) {
      const member = asObject(raw, "matched member") as unknown as MatchedMember;
      const judged = {
        count: member.count,
        ...(member.relevance !== undefined ? { relevance: member.relevance } : {}),
      };
      // Nearest-node evidence from the semantic lane rides into the queue,
      // so reviewing a suggestion never requires reopening the run.
      const nearest =
        member.candidates && member.candidates.length > 0
          ? {
              nearest: member.candidates.map((candidate) => ({
                name: candidate.name,
                path: [...candidate.path],
                score: candidate.score,
              })),
            }
          : {};
      if (member.matched && member.position) {
        entries.push({
          term: member.term,
          kind: "matched",
          detail: {
            position: positionArtifact(member.position),
            ...(member.matchScore !== undefined ? { score: member.matchScore } : {}),
            ...judged,
          },
        });
        continue;
      }
      const decision = decisions[nextDecisionIndex];
      nextDecisionIndex += 1;
      if (!decision) {
        // No node matched and the placer left no decision: queue a
        // place-anchored INSERT suggestion — the candidates name where in
        // the tree it belongs, and the reviewer decides from there.
        if (member.candidates && member.candidates.length > 0) {
          entries.push({
            term: member.term,
            kind: "insert",
            detail: {
              name: member.term,
              reason:
                "no existing node matched this term; anchored at its nearest nodes by embedding similarity",
              ...nearest,
              ...judged,
            },
          });
        } else {
          entries.push({ term: member.term, kind: "undecided", detail: judged });
        }
        continue;
      }
      if (decision.outcome === "undecidable") {
        // The placer's honest exit: no defensible placement exists. With
        // nearest-node evidence the term still enters the queue as a
        // place-anchored INSERT candidate for human review; without any it
        // is recorded as undecided with the placer's reason.
        if (member.candidates && member.candidates.length > 0) {
          entries.push({
            term: member.term,
            kind: "insert",
            detail: { name: member.term, reason: decision.reason, ...nearest, ...judged },
          });
        } else {
          entries.push({
            term: member.term,
            kind: "undecided",
            detail: { reason: decision.reason, ...judged },
          });
        }
        continue;
      }
      entries.push({
        term: member.term,
        kind: decision.outcome,
        detail:
          decision.outcome === "place"
            ? {
                name: decision.name,
                parent: decision.parent,
                aliases: [...(decision.aliases ?? [])],
                reason: decision.reason,
                ...nearest,
                ...judged,
              }
            : { node: decision.node, reason: decision.reason, ...judged },
      });
    }

    const receipt = await taxonomy.suggest(entries, context.runId);
    return {
      id: receipt.id,
      receivedAt: receipt.receivedAt,
      revision: receipt.revision,
      queued: receipt.queued,
      entries: entries.map((entry) => ({ term: entry.term, kind: entry.kind })),
    } as unknown as JsonValue;
  };

  const bridge: DeterministicActivityHandler = async (input) => {
    // Optional for one published version's sake: bundles before the pool bind
    // (v0.9.0) still bridge fine, they just carry no grounding on the tree.
    const pool = input.pool !== undefined ? asObject(input.pool, "pool") : {};
    const matches = asObject(input.matches, "matches");
    const placements = asObject(input.placements, "placements");
    const maxDepartments = positiveInteger(input.maxDepartments, "maxDepartments");
    const members = asArray(matches.members, "matches.members").map(
      (raw) => asObject(raw, "matched member") as unknown as MatchedMember,
    );
    const decisions = asArray(placements.decisions, "placements.decisions").map(
      (raw) => asObject(raw, "placement decision") as unknown as PlacementDecisionInput,
    );
    // Positional against the unmatched members, not term-keyed — see the
    // matching comment in `suggest` above. A duplicate term (a split half
    // colliding with an unrelated standalone member of the same name) must
    // not let one member's placement decision bleed into another's seating.
    let nextDecisionIndex = 0;

    // Resolve every member to a landing position: matched members carry it;
    // placed members land one level below their (existing) parent; members the
    // placer reported already_present resolve through the live tree.
    interface Landing {
      readonly path: readonly string[];
      readonly level: "domain" | "field" | "subfield" | "topic";
      readonly count: number;
      readonly relevance: number;
    }
    const landings: Landing[] = [];
    for (const member of members) {
      const relevance = relevanceOf(member);
      if (member.matched && member.position) {
        landings.push({
          path: member.position.path,
          level: member.position.level,
          count: member.count,
          relevance,
        });
        continue;
      }
      const decision = decisions[nextDecisionIndex];
      nextDecisionIndex += 1;
      if (!decision) continue; // undecided members carry no seatable landing
      if (decision.outcome === "already_present" && decision.node) {
        const resolved = await taxonomy.resolve(decision.node);
        if (resolved.found) {
          landings.push({
            path: resolved.position.path,
            level: resolved.position.level,
            count: member.count,
            relevance,
          });
        }
        continue;
      }
      if (decision.outcome === "place" && decision.parent && decision.name) {
        const parent = await taxonomy.resolve(decision.parent);
        if (!parent.found || parent.position.level === "topic") continue;
        const levels = ["domain", "field", "subfield", "topic"] as const;
        const childLevel = levels[levels.indexOf(parent.position.level) + 1]!;
        landings.push({
          path: [...parent.position.path, decision.name],
          level: childLevel,
          count: member.count,
          relevance,
        });
      }
    }

    // Fold landings into the legacy experts tree: department <- field,
    // umbrella <- subfield, leaf <- topic; domain-level landings are too
    // coarse to seat and are dropped. Counts sum the distinct-people support;
    // relevance carries the pool builder's input-topic score as the MAX over
    // every member landing at or below a node — every level is sorted by it.
    interface LeafAcc {
      count: number;
      relevance: number;
    }
    interface UmbrellaAcc {
      count: number;
      relevance: number;
      subfields: Map<string, LeafAcc>;
    }
    interface DepartmentAcc {
      domain: string;
      count: number;
      relevance: number;
      umbrellas: Map<string, UmbrellaAcc>;
    }
    const departments = new Map<string, DepartmentAcc>();
    for (const landing of landings) {
      const [domain, field, subfield, topic] = [
        landing.path[0],
        landing.path[1],
        landing.path[2],
        landing.path[3],
      ];
      if (!domain || !field) continue;
      const department =
        departments.get(field) ??
        ({ domain, count: 0, relevance: 0, umbrellas: new Map() } satisfies DepartmentAcc);
      departments.set(field, department);
      department.count += landing.count;
      department.relevance = Math.max(department.relevance, landing.relevance);
      if (!subfield) continue;
      const umbrella =
        department.umbrellas.get(subfield) ??
        ({ count: 0, relevance: 0, subfields: new Map() } satisfies UmbrellaAcc);
      department.umbrellas.set(subfield, umbrella);
      umbrella.count += landing.count;
      umbrella.relevance = Math.max(umbrella.relevance, landing.relevance);
      if (topic) {
        const leaf = umbrella.subfields.get(topic) ?? { count: 0, relevance: 0 };
        umbrella.subfields.set(topic, leaf);
        leaf.count += landing.count;
        leaf.relevance = Math.max(leaf.relevance, landing.relevance);
      }
    }

    const tree = [...departments.entries()]
      .sort(
        (a, b) =>
          b[1].relevance - a[1].relevance ||
          b[1].count - a[1].count ||
          a[0].localeCompare(b[0]),
      )
      .slice(0, Math.min(maxDepartments, 12))
      .map(([name, department]) => ({
        name,
        domain: department.domain,
        count: Math.max(1, department.count),
        relevance: department.relevance,
        umbrellas: [...department.umbrellas.entries()]
          .sort(
            (a, b) =>
              b[1].relevance - a[1].relevance ||
              b[1].count - a[1].count ||
              a[0].localeCompare(b[0]),
          )
          .slice(0, 30)
          .map(([umbrellaName, umbrella]) => ({
            name: umbrellaName,
            count: Math.max(1, umbrella.count),
            relevance: umbrella.relevance,
            subfields:
              umbrella.subfields.size > 0
                ? [...umbrella.subfields.entries()]
                    .sort(
                      (a, b) =>
                        b[1].relevance - a[1].relevance ||
                        b[1].count - a[1].count ||
                        a[0].localeCompare(b[0]),
                    )
                    .slice(0, 30)
                    .map(([leafName, leaf]) => ({
                      name: leafName,
                      count: Math.max(1, leaf.count),
                      relevance: leaf.relevance,
                    }))
                : [{ name: `various topics under ${umbrellaName}`, count: 1, relevance: umbrella.relevance }],
          })),
      }));

    if (tree.length === 0) {
      throw new Error(
        "experts.bridge produced no departments — no pool member landed on a field-bearing taxonomy position",
      );
    }
    // The pool's literature grounding rides through onto the tree: the
    // dashboard's papers/authors/interests record, never used for seating.
    return {
      departments: tree,
      ...(pool.grounding !== undefined ? { grounding: pool.grounding } : {}),
    } as unknown as JsonValue;
  };

  return {
    "taxonomy.match": match,
    "taxonomy.suggest": suggest,
    "experts.bridge": bridge,
  };
}
