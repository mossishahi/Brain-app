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
 * The stated focus of a seat won by an UMBRELLA or a DEPARTMENT (never a
 * single topic seating on its own merit) — deliberately generic rather than
 * every topic name the branch happened to accumulate. Those topics are real
 * pool support (they are why the branch out-scored its competitors and won
 * a seat at all), but most of them, individually, are far weaker evidence
 * than the one or two topics that actually earned the seat: an umbrella's
 * cxr is `count × relevance`, and relevance is the MAX over its children
 * (`experts.bridge`'s fold) — so a seat can be won by one 0.55-relevant
 * topic while its label used to print three near-zero siblings right beside
 * it, unfiltered, as if they mattered equally. Printing this fixed phrase
 * into `{{subfields}}` instead states plainly what is actually true of an
 * umbrella/department-level seat's focus — broad, real, and topically
 * relevant to the run — without claiming a false precision the underlying
 * numbers do not support. Topic-level seats (a single topic winning on its
 * own cxr) keep their real, specific topic name; only a branch that won as
 * a block gets this generic phrase.
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
 * 2. all of them are mixed into one queue, sorted by cxr descending;
 * 3. with capacity = panelSize, pop the head of the queue while capacity
 *    remains:
 *    - a TOPIC (level 4) seats a member with that single focus;
 *    - an UMBRELLA (level 3) first LOOKS AHEAD: if any of its own topics sit
 *      within the next `capacity` live queue entries, the umbrella is
 *      skipped without spending capacity — its topics will seat themselves.
 *      Otherwise it seats a member with itself as the umbrella and
 *      `BROAD_SEAT_FOCUS` (a fixed, generic phrase, not its topics' real
 *      names — see that constant) as the stated focus, and removes the
 *      branch's remaining level-4 entries from the queue;
 *    - a DEPARTMENT (level 2) looks ahead the same way: if any of its own
 *      umbrellas sit within the next `capacity` live entries, the department
 *      is skipped without spending capacity. Otherwise it picks its
 *      highest-cxr umbrella still in the queue, seats a member with that
 *      umbrella and `BROAD_SEAT_FOCUS` as its focus, and removes the picked
 *      umbrella and its level-4 entries. A
 *      department whose umbrellas are all consumed (or that houses none)
 *      seats nobody and the loop moves on without spending capacity.
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
      const umbrella = department.umbrellas[entry.umbrellaIndex]!;
      const focuses = [BROAD_SEAT_FOCUS];
      if (!seated.has(seatOf(department.name, umbrella.name, focuses))) {
        seat(department.name, umbrella.name, focuses);
        removeSubfieldEntries(entry.departmentIndex, entry.umbrellaIndex);
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
    // Otherwise seat through the department's best umbrella still available.
    let picked: SeatingQueueEntry | undefined;
    for (const candidate of queue) {
      if (candidate.level !== 3 || candidate.departmentIndex !== entry.departmentIndex) continue;
      if (removed.has(entryKey(candidate))) continue;
      picked = candidate; // the queue is sorted, so the first hit is the max
      break;
    }
    if (!picked) continue; // nothing left to represent this department with
    const umbrella = department.umbrellas[picked.umbrellaIndex]!;
    const focuses = [BROAD_SEAT_FOCUS];
    if (seated.has(seatOf(department.name, umbrella.name, focuses))) continue;
    seat(department.name, umbrella.name, focuses);
    removed.add(entryKey(picked));
    removeSubfieldEntries(entry.departmentIndex, picked.umbrellaIndex);
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
