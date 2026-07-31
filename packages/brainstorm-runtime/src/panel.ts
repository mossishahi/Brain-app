import type { ExpertsTree, Panel, PanelMember } from "@brainstorm-agentic/content";

import { BrainstormRuntimeError } from "./errors.js";

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BrainstormRuntimeError(`${name} must be a positive integer`, "INVALID_PANEL_OPTIONS");
  }
}

/**
 * The seating value of a node: its pool count times its input-topic
 * relevance (c × r). Relevance is REQUIRED: trees from before it existed are
 * dead history — their runs are restarted under the current pipeline, never
 * seated with guessed values.
 */
function cxr(count: number, relevance: number | undefined, node: string): number {
  if (typeof relevance !== "number") {
    throw new BrainstormRuntimeError(
      `expertise tree node "${node}" carries no relevance — pre-relevance history is not supported; restart the run under the current pipeline`,
      "MISSING_RELEVANCE",
    );
  }
  return count * relevance;
}

/**
 * The mul_expertise view: the pruned tree annotated with the exact seating
 * value (cxr = count × relevance) panel selection queues on — umbrellas and
 * subfields with their own c × r, departments with the SUM of their
 * umbrellas' values (their own c × r when they house no umbrella).
 */
export interface ScoredExpertiseTree {
  readonly departments: readonly {
    readonly name: string;
    readonly domain?: string;
    readonly count: number;
    readonly relevance?: number;
    /** Seating value: Σ over its umbrellas' cxr (own c × r when none). */
    readonly cxr: number;
    readonly umbrellas: readonly {
      readonly name: string;
      readonly count: number;
      readonly relevance?: number;
      /** Seating value: count × relevance. */
      readonly cxr: number;
      readonly subfields: readonly {
        readonly name: string;
        readonly count: number;
        readonly relevance?: number;
        /** Seating value: count × relevance. */
        readonly cxr: number;
      }[];
    }[];
  }[];
}

export function scoreExpertiseTree(tree: ExpertsTree): ScoredExpertiseTree {
  return {
    departments: tree.departments.map((department) => {
      const umbrellas = department.umbrellas.map((umbrella) => ({
        name: umbrella.name,
        count: umbrella.count,
        ...(umbrella.relevance !== undefined ? { relevance: umbrella.relevance } : {}),
        cxr: cxr(umbrella.count, umbrella.relevance, umbrella.name),
        subfields: umbrella.subfields.map((subfield) => ({
          name: subfield.name,
          count: subfield.count,
          ...(subfield.relevance !== undefined ? { relevance: subfield.relevance } : {}),
          cxr: cxr(subfield.count, subfield.relevance, subfield.name),
        })),
      }));
      return {
        name: department.name,
        ...(department.domain !== undefined ? { domain: department.domain } : {}),
        count: department.count,
        ...(department.relevance !== undefined ? { relevance: department.relevance } : {}),
        cxr:
          umbrellas.length > 0
            ? umbrellas.reduce((sum, umbrella) => sum + umbrella.cxr, 0)
            : cxr(department.count, department.relevance, department.name),
        umbrellas,
      };
    }),
  };
}

/** One node of the mixed seating queue (tree levels 2, 3 and 4). */
export interface SeatingQueueEntry {
  /** 2 = department (taxonomy field), 3 = umbrella (subfield), 4 = topic. */
  readonly level: 2 | 3 | 4;
  /** The node's seating value (cxr as defined per level). */
  readonly value: number;
  /** The node's pool count — first tie-break. */
  readonly count: number;
  readonly departmentIndex: number;
  /** -1 for level-2 entries. */
  readonly umbrellaIndex: number;
  /** -1 for level-2/3 entries. */
  readonly subfieldIndex: number;
}

function entryKey(entry: SeatingQueueEntry): string {
  return `${entry.level}:${entry.departmentIndex}:${entry.umbrellaIndex}:${entry.subfieldIndex}`;
}

/**
 * EVERY node of the pruned tree at levels 2, 3 and 4, mixed into one queue
 * and sorted by seating value, descending. Ties break by count, then by the
 * tree's own depth-first order (departments before their umbrellas before
 * their subfields) — Array.prototype.sort is stable, so the enumeration
 * order is the final tie-break.
 */
export function seatingQueue(tree: ExpertsTree): SeatingQueueEntry[] {
  const scored = scoreExpertiseTree(tree);
  const entries: SeatingQueueEntry[] = [];
  scored.departments.forEach((department, departmentIndex) => {
    entries.push({
      level: 2,
      value: department.cxr,
      count: department.count,
      departmentIndex,
      umbrellaIndex: -1,
      subfieldIndex: -1,
    });
    department.umbrellas.forEach((umbrella, umbrellaIndex) => {
      entries.push({
        level: 3,
        value: umbrella.cxr,
        count: umbrella.count,
        departmentIndex,
        umbrellaIndex,
        subfieldIndex: -1,
      });
      umbrella.subfields.forEach((subfield, subfieldIndex) => {
        entries.push({
          level: 4,
          value: subfield.cxr,
          count: subfield.count,
          departmentIndex,
          umbrellaIndex,
          subfieldIndex,
        });
      });
    });
  });
  return entries.sort(
    (left, right) => right.value - left.value || right.count - left.count,
  );
}

/**
 * Deterministic panel seating over the PRUNED expertise tree (every node on
 * it had pool support), run by the orchestrator — no model call:
 *
 * 1. every level-2/3/4 node carries its cxr seating value (see
 *    scoreExpertiseTree);
 * 2. all of them are mixed into one queue, sorted by cxr descending;
 * 3. with capacity = panelSize, pop the head of the queue while capacity
 *    remains:
 *    - a TOPIC (level 4) seats a member with that single focus;
 *    - an UMBRELLA (level 3) seats a member with itself as the umbrella and
 *      ALL of its subfields as the stated focuses, and removes the branch's
 *      remaining level-4 entries from the queue;
 *    - a DEPARTMENT (level 2) picks its highest-cxr umbrella still in the
 *      queue, seats a member with that umbrella and the union of the
 *      umbrella term and its subfields as focuses, and removes the picked
 *      umbrella and its level-4 entries from the queue. A department whose
 *      umbrellas are all consumed (or that houses none) seats nobody and the
 *      loop moves on without spending capacity.
 *
 * Exhausted branches leave the queue recursively: whenever a node is
 * consumed, its parent is checked — a parent with no remaining children in
 * the queue is removed too, and the check repeats one level up. One member
 * per (department, umbrella) seat: a would-be duplicate is skipped, never
 * seated twice. Selection stops at panelSize or queue exhaustion; member ids
 * follow pick order.
 */
export function selectPanel(experts: ExpertsTree, panelSize: number): Panel {
  positiveInteger(panelSize, "panelSize");

  const queue = seatingQueue(experts);
  const removed = new Set<string>();
  const seated = new Set<string>();
  const members: PanelMember[] = [];
  const seatOf = (department: string, umbrella: string): string => `${department}\u0000${umbrella}`;

  const seat = (department: string, umbrella: string, subfields: readonly string[]): void => {
    members.push({
      id: `member-${members.length + 1}`,
      department,
      umbrella,
      subfields: [...subfields],
    });
    seated.add(seatOf(department, umbrella));
  };

  const inQueue = (level: 2 | 3 | 4, departmentIndex: number, umbrellaIndex: number): boolean =>
    queue.some(
      (entry) =>
        entry.level === level &&
        entry.departmentIndex === departmentIndex &&
        (level === 2 || entry.umbrellaIndex === umbrellaIndex) &&
        !removed.has(entryKey(entry)),
    );

  /**
   * The recursive exhaustion rule: after consuming a node, when its parent
   * has no other child left in the queue, the parent is removed as well —
   * and the same condition is then checked for the grandparent.
   */
  const cascadeFromUmbrella = (departmentIndex: number, umbrellaIndex: number): void => {
    if (inQueue(4, departmentIndex, umbrellaIndex)) return; // children remain
    const umbrellaEntry = queue.find(
      (entry) =>
        entry.level === 3 &&
        entry.departmentIndex === departmentIndex &&
        entry.umbrellaIndex === umbrellaIndex,
    );
    if (umbrellaEntry && !removed.has(entryKey(umbrellaEntry))) {
      removed.add(entryKey(umbrellaEntry));
    }
    cascadeFromDepartment(departmentIndex);
  };
  const cascadeFromDepartment = (departmentIndex: number): void => {
    if (inQueue(3, departmentIndex, -1)) return; // an umbrella remains
    const departmentEntry = queue.find(
      (entry) => entry.level === 2 && entry.departmentIndex === departmentIndex,
    );
    if (departmentEntry && !removed.has(entryKey(departmentEntry))) {
      removed.add(entryKey(departmentEntry));
    }
  };

  const removeSubfieldEntries = (departmentIndex: number, umbrellaIndex: number): void => {
    for (const entry of queue) {
      if (
        entry.level === 4 &&
        entry.departmentIndex === departmentIndex &&
        entry.umbrellaIndex === umbrellaIndex
      ) {
        removed.add(entryKey(entry));
      }
    }
  };

  let capacity = panelSize;
  for (const entry of queue) {
    if (capacity <= 0) break;
    if (removed.has(entryKey(entry))) continue;
    removed.add(entryKey(entry)); // popped
    const department = experts.departments[entry.departmentIndex]!;

    if (entry.level === 4) {
      const umbrella = department.umbrellas[entry.umbrellaIndex]!;
      const taken = seated.has(seatOf(department.name, umbrella.name));
      if (!taken) {
        const subfield = umbrella.subfields[entry.subfieldIndex]!;
        seat(department.name, umbrella.name, [subfield.name]);
        capacity -= 1;
      }
      // Picking a level-4 node: when its parent has no other child left, the
      // parent goes too — recursively up the tree.
      cascadeFromUmbrella(entry.departmentIndex, entry.umbrellaIndex);
      continue;
    }

    if (entry.level === 3) {
      const umbrella = department.umbrellas[entry.umbrellaIndex]!;
      if (!seated.has(seatOf(department.name, umbrella.name))) {
        seat(
          department.name,
          umbrella.name,
          umbrella.subfields.map((subfield) => subfield.name),
        );
        removeSubfieldEntries(entry.departmentIndex, entry.umbrellaIndex);
        capacity -= 1;
      }
      cascadeFromDepartment(entry.departmentIndex);
      continue;
    }

    // Level 2: seat through the department's best umbrella still available.
    let picked: SeatingQueueEntry | undefined;
    for (const candidate of queue) {
      if (candidate.level !== 3 || candidate.departmentIndex !== entry.departmentIndex) continue;
      if (removed.has(entryKey(candidate))) continue;
      const candidateUmbrella = department.umbrellas[candidate.umbrellaIndex]!;
      if (seated.has(seatOf(department.name, candidateUmbrella.name))) continue;
      picked = candidate; // the queue is sorted, so the first hit is the max
      break;
    }
    if (!picked) continue; // nothing left to represent this department with
    const umbrella = department.umbrellas[picked.umbrellaIndex]!;
    seat(department.name, umbrella.name, [
      umbrella.name,
      ...umbrella.subfields.map((subfield) => subfield.name),
    ]);
    removed.add(entryKey(picked));
    removeSubfieldEntries(entry.departmentIndex, picked.umbrellaIndex);
    capacity -= 1;
  }

  return { members };
}
