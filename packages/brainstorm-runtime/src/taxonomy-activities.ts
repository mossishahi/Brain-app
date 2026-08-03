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
      } else {
        annotated.push(null);
        pending.push({
          slot: annotated.length - 1,
          entry: { base, options: result.options },
        });
      }
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

    return {
      revision,
      members: annotated as JsonValue[],
      unmatched,
      embedding: semantic
        ? { enabled: true, embedderId: served!.embedder.id }
        : { enabled: false, ...(laneReason ? { reason: laneReason } : {}) },
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
    const decisionByTerm = new Map(decisions.map((decision) => [decision.term, decision]));

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
      const decision = decisionByTerm.get(member.term);
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
    const decisionByTerm = new Map(decisions.map((decision) => [decision.term, decision]));

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
      const decision = decisionByTerm.get(member.term);
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
