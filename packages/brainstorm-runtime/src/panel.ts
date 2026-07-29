import type { ExpertsTree, Panel, PanelMember } from "@brainstorm-agentic/content";

import { BrainstormRuntimeError } from "./errors.js";

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BrainstormRuntimeError(`${name} must be a positive integer`, "INVALID_PANEL_OPTIONS");
  }
}

/**
 * Original stable chunked round-robin panel selection:
 * - one seat per (department, umbrella) leaf;
 * - take up to moduleSize leaves from each department per pass;
 * - skip exhausted departments;
 * - preserve declared array/relevance order;
 * - stop at panelSize or tree exhaustion.
 *
 * moduleSize=1 is breadth-first round-robin, while a sufficiently large
 * moduleSize exhausts each department in depth-first order.
 */
export function selectPanel(
  experts: ExpertsTree,
  panelSize: number,
  moduleSize: number,
): Panel {
  positiveInteger(panelSize, "panelSize");
  positiveInteger(moduleSize, "moduleSize");

  const queues = experts.departments.map((department) => ({
    position: 0,
    members: department.umbrellas.map((umbrella): Omit<PanelMember, "id"> => {
      // The tree's subfields carry their support counts; a seat needs only the
      // names it will state as its research focuses. An umbrella can reach a
      // seat with no subfield under it — the pool surfaced the field but
      // nothing narrower — and the seat still has to name a focus, so it falls
      // back to the field itself rather than an empty list.
      const focuses = umbrella.subfields.map((subfield) => subfield.name);
      return {
        department: department.name,
        umbrella: umbrella.name,
        subfields: focuses.length > 0 ? focuses : [umbrella.name],
      };
    }),
  }));

  const members: PanelMember[] = [];
  let progressed = true;
  while (members.length < panelSize && progressed) {
    progressed = false;
    for (const queue of queues) {
      let taken = 0;
      while (
        taken < moduleSize &&
        queue.position < queue.members.length &&
        members.length < panelSize
      ) {
        const seat = queue.members[queue.position++]!;
        members.push({ id: `member-${members.length + 1}`, ...seat });
        taken += 1;
        progressed = true;
      }
      if (members.length >= panelSize) break;
    }
  }
  return { members };
}
