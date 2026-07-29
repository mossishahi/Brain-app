import type { ExpertsTree, Panel, PanelMember } from "@brainstorm-agentic/content";

import { BrainstormRuntimeError } from "./errors.js";

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BrainstormRuntimeError(`${name} must be a positive integer`, "INVALID_PANEL_OPTIONS");
  }
}

/** One scored umbrella: new j = j × (sum of its subfields' i counts). */
export interface ScoredUmbrella {
  readonly department: string;
  readonly umbrella: string;
  /** j — distinct people who stated the umbrella itself. */
  readonly count: number;
  /** Sum of i over the umbrella's subfields. */
  readonly subfieldSum: number;
  /** new j = j × subfieldSum. */
  readonly score: number;
  /** Every subfield name under the umbrella, in tree order. */
  readonly subfields: readonly string[];
  readonly treeIndex: number;
}

/**
 * The mul_expertise view: the raw tree with every umbrella re-weighted as
 * new j = j × (sum of its subfields' i counts). Subfield counts are reported
 * unchanged — the leaf level keeps its original scores — and departments keep
 * their k.
 */
export interface ScoredExpertiseTree {
  readonly departments: readonly {
    readonly name: string;
    readonly domain?: string;
    readonly count: number;
    readonly umbrellas: readonly {
      readonly name: string;
      /** j as measured from the pool. */
      readonly count: number;
      /** new j = j × sum(i). */
      readonly score: number;
      readonly subfields: readonly { readonly name: string; readonly count: number }[];
    }[];
  }[];
}

/** Umbrellas in tree order, each carrying its new-j score. */
export function scoredUmbrellas(tree: ExpertsTree): ScoredUmbrella[] {
  const umbrellas: ScoredUmbrella[] = [];
  let index = 0;
  for (const department of tree.departments) {
    for (const umbrella of department.umbrellas) {
      const subfieldSum = umbrella.subfields.reduce((sum, subfield) => sum + subfield.count, 0);
      umbrellas.push({
        department: department.name,
        umbrella: umbrella.name,
        count: umbrella.count,
        subfieldSum,
        score: umbrella.count * subfieldSum,
        subfields: umbrella.subfields.map((subfield) => subfield.name),
        treeIndex: index++,
      });
    }
  }
  return umbrellas;
}

export function scoreExpertiseTree(tree: ExpertsTree): ScoredExpertiseTree {
  return {
    departments: tree.departments.map((department) => ({
      name: department.name,
      ...(department.domain !== undefined ? { domain: department.domain } : {}),
      count: department.count,
      umbrellas: department.umbrellas.map((umbrella) => {
        const subfieldSum = umbrella.subfields.reduce((sum, subfield) => sum + subfield.count, 0);
        return {
          name: umbrella.name,
          count: umbrella.count,
          score: umbrella.count * subfieldSum,
          subfields: umbrella.subfields.map((subfield) => ({
            name: subfield.name,
            count: subfield.count,
          })),
        };
      }),
    })),
  };
}

/**
 * Panel selection: one member per UMBRELLA, the panelSize highest new-j
 * scores (j × sum of subfield counts), ties keeping tree order. A seat
 * carries every subfield of its umbrella as its stated research focuses;
 * an umbrella that arrived with none carries the runtime's catch-all
 * "various topics under <umbrella>" leaf instead, so a member always has a
 * focus to state.
 */
export function selectPanel(experts: ExpertsTree, panelSize: number): Panel {
  positiveInteger(panelSize, "panelSize");

  const members: PanelMember[] = [...scoredUmbrellas(experts)]
    // Array.prototype.sort is stable, so equal scores keep tree order.
    .sort((left, right) => right.score - left.score)
    .slice(0, panelSize)
    .map((umbrella, index) => ({
      id: `member-${index + 1}`,
      department: umbrella.department,
      umbrella: umbrella.umbrella,
      subfields: [...umbrella.subfields],
    }));
  return { members };
}
