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

/**
 * The stated focus of a branch-won seat that has NO live topic left to name
 * — the FALLBACK, never the normal label. A branch that wins a seat walks
 * down the queue and claims its strongest live topic's real name as the
 * seat's focus (see selectPanel), so `{{subfields}}` normally carries a
 * genuine, specific term. This phrase appears only when every topic of the
 * winning branch was already consumed by earlier seats (or the branch never
 * carried one): the seat is then honestly broad, and the label says so
 * without inventing precision.
 *
 * History: this phrase briefly served as the label of EVERY branch-won seat
 * (replacing the older join-every-topic-name list). But the scores make
 * branch wins the COMMON case, not the rare one — a parent's cxr is the sum
 * of its children's counts times their maximum relevance, so every parent
 * outranks all of its own children and the look-ahead window nearly never
 * reaches a topic — which turned the whole panel's focuses into this one
 * phrase (observed on bsa_20260821-175607_5c9992: six seats, six identical
 * generic focuses). The walk-down claim restores a real name per seat while
 * still never printing the branch's weak siblings as if they mattered.
 */
const BROAD_SEAT_FOCUS = "super relevant to this project";

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
 * 2. all of them are mixed into one queue, sorted by cxr descending —
 *    count × relevance is the ONE ordering, for the queue and for every
 *    walk-down below;
 * 3. with capacity = panelSize, pop the head of the queue while capacity
 *    remains:
 *    - a TOPIC (level 4) seats a member with that single focus;
 *    - an UMBRELLA (level 3) first LOOKS AHEAD: if any of its own topics sit
 *      within the next `capacity` live queue entries (the SHRINKING window —
 *      exactly the seats still open), the umbrella is skipped without
 *      spending capacity. The skip is a promise the queue always keeps: at
 *      most capacity−1 live entries stand before that topic, each consuming
 *      at most one seat, so the topic is guaranteed to seat itself with its
 *      real name. Otherwise the umbrella WALKS DOWN the queue to its
 *      strongest live topic (the first in cxr order) and seats a member with
 *      the umbrella and THAT topic's real name as the stated focus,
 *      consuming exactly that topic entry — sibling topics stay in the
 *      queue and may still win their own seats later. Only an umbrella with
 *      no live topic left falls back to `BROAD_SEAT_FOCUS`;
 *    - a DEPARTMENT (level 2) looks ahead the same way over its own
 *      umbrellas and is skipped without spending capacity when one sits in
 *      the window. Otherwise it walks down to its strongest live umbrella,
 *      takes that umbrella's strongest live topic as the seat's stated
 *      focus, and consumes both entries; the umbrella's remaining topics
 *      stay seatable. A department whose umbrellas are all consumed (or
 *      that houses none) seats nobody and the loop moves on without
 *      spending capacity; a found umbrella with no live topic falls back to
 *      `BROAD_SEAT_FOCUS`.
 *
 * Exhausted branches leave the queue recursively: whenever a node is
 * consumed, its parent is checked — a parent with no remaining children in
 * the queue is removed too, and the check repeats one level up. Seats are
 * exact: several members may share an umbrella (topic-level seats under one
 * branch), but the identical focus set is never seated twice. Selection
 * stops at panelSize or queue exhaustion; member ids follow pick order.
 */
export function selectPanel(experts: ExpertsTree, panelSize: number): Panel {
  positiveInteger(panelSize, "panelSize");

  const queue = seatingQueue(experts);
  const removed = new Set<string>();
  const seated = new Set<string>();
  const members: PanelMember[] = [];
  const seatOf = (department: string, umbrella: string, subfields: readonly string[]): string =>
    `${department}\u0000${umbrella}\u0000${subfields.join("\u0001")}`;

  const seat = (department: string, umbrella: string, subfields: readonly string[]): void => {
    members.push({
      id: `member-${members.length + 1}`,
      department,
      umbrella,
      subfields: [...subfields],
    });
    seated.add(seatOf(department, umbrella, subfields));
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

  /**
   * The strongest LIVE entry satisfying `predicate`, in queue (cxr) order.
   * Everything above the loop's cursor is already popped and marked removed,
   * so scanning the whole queue front-to-back is exactly "walk down from
   * here": the first live hit is the highest-cxr candidate still standing.
   */
  const firstLive = (
    predicate: (candidate: SeatingQueueEntry) => boolean,
  ): SeatingQueueEntry | undefined =>
    queue.find((candidate) => !removed.has(entryKey(candidate)) && predicate(candidate));

  let capacity = panelSize;
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index]!;
    if (capacity <= 0) break;
    if (removed.has(entryKey(entry))) continue;
    removed.add(entryKey(entry)); // popped
    const department = experts.departments[entry.departmentIndex]!;

    /**
     * The look-ahead of the corrected algorithm: does any entry satisfying
     * `predicate` sit within the next `capacity` LIVE queue entries after
     * the current one? (Working on the 3rd item with capacity 4 checks the
     * 4th through 7th live items.)
     */
    const withinNextCapacityItems = (
      predicate: (candidate: SeatingQueueEntry) => boolean,
    ): boolean => {
      let inspected = 0;
      for (let ahead = index + 1; ahead < queue.length && inspected < capacity; ahead += 1) {
        const candidate = queue[ahead]!;
        if (removed.has(entryKey(candidate))) continue;
        inspected += 1;
        if (predicate(candidate)) return true;
      }
      return false;
    };

    if (entry.level === 4) {
      const umbrella = department.umbrellas[entry.umbrellaIndex]!;
      const subfield = umbrella.subfields[entry.subfieldIndex]!;
      if (!seated.has(seatOf(department.name, umbrella.name, [subfield.name]))) {
        seat(department.name, umbrella.name, [subfield.name]);
        capacity -= 1;
      }
      // Picking a level-4 node: when its parent has no other child left, the
      // parent goes too — recursively up the tree.
      cascadeFromUmbrella(entry.departmentIndex, entry.umbrellaIndex);
      continue;
    }

    if (entry.level === 3) {
      // Skip the umbrella when any of its own topics are close enough to
      // seat themselves — the more specific seats win; capacity unchanged.
      if (
        withinNextCapacityItems(
          (candidate) =>
            candidate.level === 4 &&
            candidate.departmentIndex === entry.departmentIndex &&
            candidate.umbrellaIndex === entry.umbrellaIndex,
        )
      ) {
        cascadeFromDepartment(entry.departmentIndex);
        continue;
      }
      // No topic within reach: the umbrella wins the seat, and walks down
      // the queue to claim its strongest live topic as the seat's REAL
      // focus. Only that one entry is consumed — the siblings stay in the
      // queue, so a strong branch can still win further, more specific
      // seats later.
      const umbrella = department.umbrellas[entry.umbrellaIndex]!;
      const topicEntry = firstLive(
        (candidate) =>
          candidate.level === 4 &&
          candidate.departmentIndex === entry.departmentIndex &&
          candidate.umbrellaIndex === entry.umbrellaIndex,
      );
      const focuses =
        topicEntry !== undefined
          ? [umbrella.subfields[topicEntry.subfieldIndex]!.name]
          : [BROAD_SEAT_FOCUS];
      if (!seated.has(seatOf(department.name, umbrella.name, focuses))) {
        if (topicEntry !== undefined) removed.add(entryKey(topicEntry));
        seat(department.name, umbrella.name, focuses);
        capacity -= 1;
      }
      cascadeFromDepartment(entry.departmentIndex);
      continue;
    }

    // Level 2: skip the department when any of its own umbrellas are close
    // enough to seat themselves; capacity unchanged.
    if (
      withinNextCapacityItems(
        (candidate) =>
          candidate.level === 3 && candidate.departmentIndex === entry.departmentIndex,
      )
    ) {
      continue;
    }
    // Otherwise seat through the department's strongest umbrella still
    // available, with that umbrella's strongest live topic as the seat's
    // stated focus. Both entries are consumed; the umbrella's remaining
    // topics stay seatable.
    const picked = firstLive(
      (candidate) =>
        candidate.level === 3 && candidate.departmentIndex === entry.departmentIndex,
    );
    if (!picked) continue; // nothing left to represent this department with
    const umbrella = department.umbrellas[picked.umbrellaIndex]!;
    const topicEntry = firstLive(
      (candidate) =>
        candidate.level === 4 &&
        candidate.departmentIndex === entry.departmentIndex &&
        candidate.umbrellaIndex === picked.umbrellaIndex,
    );
    const focuses =
      topicEntry !== undefined
        ? [umbrella.subfields[topicEntry.subfieldIndex]!.name]
        : [BROAD_SEAT_FOCUS];
    if (seated.has(seatOf(department.name, umbrella.name, focuses))) continue;
    seat(department.name, umbrella.name, focuses);
    removed.add(entryKey(picked));
    if (topicEntry !== undefined) removed.add(entryKey(topicEntry));
    capacity -= 1;
  }

  return { members };
}

/** Department name of the appended interdisciplinary seat. */
export const INTERDISCIPLINARY_DEPARTMENT = "Interdisciplinary Research";

/** "A", "A and B", "A, B and C" — an English list for prompt-rendered seat strings. */
function englishList(entries: readonly string[]): string {
  if (entries.length <= 1) return entries[0] ?? "";
  if (entries.length === 2) return `${entries[0]} and ${entries[1]}`;
  return `${entries.slice(0, -1).join(", ")} and ${entries[entries.length - 1]}`;
}

/**
 * Deterministic seat weave, run by the orchestrator after panel selection —
 * no model call: appends ONE interdisciplinary member whose expertise is the
 * space BETWEEN the seated fields, so the panel carries a seat for exactly
 * the areas no disciplinary member owns. The member is a full panel member —
 * it develops, is reviewed, and redevelops like every other seat; only its
 * commenting skill differs (dispatched on the `seat` marker).
 *
 * The seat strings are derived from the seated members' umbrella terms
 * (unique, in seat order) so the existing role skills render its identity
 * naturally. The weave is skipped — the panel returned unchanged — when the
 * panel spans fewer than two distinct umbrellas (a one-field panel has no
 * between-space) or when adding a seat would exceed maxSeats.
 */
export function weavePanel(panel: Panel, maxSeats: number): Panel {
  positiveInteger(maxSeats, "maxSeats");
  const fields: string[] = [];
  for (const member of panel.members) {
    if (member.seat === "interdisciplinary") return panel; // already woven
    if (!fields.includes(member.umbrella)) fields.push(member.umbrella);
  }
  if (fields.length < 2) return panel;
  if (panel.members.length + 1 > maxSeats) return panel;
  const listed = englishList(fields);
  return {
    members: [
      ...panel.members,
      {
        id: `member-${panel.members.length + 1}`,
        department: INTERDISCIPLINARY_DEPARTMENT,
        umbrella: `the interdisciplinary space between ${listed}`,
        subfields: [
          `the pairwise interfaces of ${listed}`,
          "methods and results that transfer between these fields",
        ],
        seat: "interdisciplinary",
      },
    ],
  };
}
