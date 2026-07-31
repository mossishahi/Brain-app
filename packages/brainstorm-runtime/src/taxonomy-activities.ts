/**
 * The deterministic activities of the decomposer split, built over an injected
 * TaxonomyAccess (the shared live taxonomy on the Brain Registry, or a local
 * fallback for offline runs). No model is ever called here.
 *
 * - `taxonomy.match` — one resolve round-trip per pool member: exact position
 *   or the server's candidate names; plus the unmatched projection the placer
 *   receives.
 * - `taxonomy.suggest` — submit a copy of the run's decision for EVERY pool
 *   member to the registry's append-only suggestion queue (recorded, never
 *   applied) and return the receipt.
 * - `experts.bridge` — TEMPORARY: fold matched positions and placement
 *   decisions into the legacy experts tree so panel selection and everything
 *   downstream keep working until the pool-based seating design lands.
 */
import type {
  JsonObject,
  JsonValue,
  TaxonomyAccess,
  TaxonomyNodePosition,
  TaxonomySuggestionEntry,
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
}

interface PlacementDecisionInput {
  readonly term: string;
  readonly outcome: "place" | "already_present";
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

export function taxonomyActivities(
  taxonomy: TaxonomyAccess,
): Readonly<Record<string, DeterministicActivityHandler>> {
  const match: DeterministicActivityHandler = async (input) => {
    const pool = asObject(input.pool, "pool");
    const maxMembers = positiveInteger(input.maxMembers, "maxMembers");
    const members = asArray(pool.members, "pool.members").slice(0, maxMembers);

    let revision = 1;
    const annotated: JsonValue[] = [];
    const unmatched: JsonValue[] = [];
    for (const raw of members) {
      const member = asObject(raw, "pool member") as unknown as PoolMemberInput;
      const result = await taxonomy.resolve(member.term);
      revision = Math.max(revision, result.revision);
      const base = {
        term: member.term,
        count: member.count,
        ...(member.relevance !== undefined ? { relevance: member.relevance } : {}),
        variants: [...member.variants],
        origins: [...member.origins],
      };
      if (result.found) {
        annotated.push({
          ...base,
          matched: true,
          position: positionArtifact(result.position),
          options: [],
        } as unknown as JsonValue);
      } else {
        const entry = {
          ...base,
          matched: false,
          options: [...result.options],
        } as unknown as JsonValue;
        annotated.push(entry);
        unmatched.push(entry);
      }
    }
    return { revision, members: annotated, unmatched } as unknown as JsonValue;
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
      if (member.matched && member.position) {
        entries.push({
          term: member.term,
          kind: "matched",
          detail: { position: positionArtifact(member.position), ...judged },
        });
        continue;
      }
      const decision = decisionByTerm.get(member.term);
      if (!decision) {
        entries.push({ term: member.term, kind: "undecided", detail: judged });
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
