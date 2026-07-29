import type { ExpertsTree, Panel, PanelMember } from "@brainstorm-agentic/content";

import { BrainstormRuntimeError } from "./errors.js";

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BrainstormRuntimeError(`${name} must be a positive integer`, "INVALID_PANEL_OPTIONS");
  }
}

/** One scored leaf of the expertise tree: subfield i × umbrella j × department k. */
export interface ScoredLeaf {
  readonly department: string;
  readonly umbrella: string;
  readonly subfield: string;
  /** i — distinct people who stated the subfield itself. */
  readonly count: number;
  /** i × j × k. */
  readonly score: number;
}

/**
 * The tree with every subfield's frequency multiplied through its parents:
 * new i = i (subfield) × j (its umbrella) × k (its department). Counts at the
 * umbrella and department levels are reported unchanged — only the leaves are
 * scored, because only leaves become seats.
 */
export interface ScoredExpertiseTree {
  readonly departments: readonly {
    readonly name: string;
    readonly domain?: string;
    readonly count: number;
    readonly umbrellas: readonly {
      readonly name: string;
      readonly count: number;
      readonly subfields: readonly { readonly name: string; readonly count: number; readonly score: number }[];
    }[];
  }[];
}

/**
 * Flattens the tree into leaves in tree order (department, then umbrella,
 * then subfield), each scored i×j×k. Tree order is the tie-break for
 * selection, so one tree always yields one panel.
 */
export function scoredLeaves(tree: ExpertsTree): ScoredLeaf[] {
  const leaves: ScoredLeaf[] = [];
  for (const department of tree.departments) {
    for (const umbrella of department.umbrellas) {
      for (const subfield of umbrella.subfields) {
        leaves.push({
          department: department.name,
          umbrella: umbrella.name,
          subfield: subfield.name,
          count: subfield.count,
          score: subfield.count * umbrella.count * department.count,
        });
      }
    }
  }
  return leaves;
}

/** The mul_expertise view: the raw tree with per-leaf i×j×k scores attached. */
export function scoreExpertiseTree(tree: ExpertsTree): ScoredExpertiseTree {
  return {
    departments: tree.departments.map((department) => ({
      name: department.name,
      ...(department.domain !== undefined ? { domain: department.domain } : {}),
      count: department.count,
      umbrellas: department.umbrellas.map((umbrella) => ({
        name: umbrella.name,
        count: umbrella.count,
        subfields: umbrella.subfields.map((subfield) => ({
          name: subfield.name,
          count: subfield.count,
          score: subfield.count * umbrella.count * department.count,
        })),
      })),
    })),
  };
}

/**
 * Panel selection: one member per subfield LEAF, the panelSize highest
 * i×j×k scores across the whole tree. Equal scores keep tree order
 * (departments are count-sorted upstream, so ties resolve toward the
 * stronger department first). No breadth balancing of any kind — the
 * product is the whole rule.
 */
export function selectPanel(experts: ExpertsTree, panelSize: number): Panel {
  positiveInteger(panelSize, "panelSize");

  const members: PanelMember[] = [...scoredLeaves(experts)]
    // Array.prototype.sort is stable, so equal scores keep tree order.
    .sort((left, right) => right.score - left.score)
    .slice(0, panelSize)
    .map((leaf, index) => ({
      id: `member-${index + 1}`,
      department: leaf.department,
      umbrella: leaf.umbrella,
      subfields: [leaf.subfield],
    }));
  return { members };
}
