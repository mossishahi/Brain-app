/**
 * A chain step as the reader sees it, in the two shapes a run can record it.
 *
 * Every run started before the chain had parts recorded a step as ONE string,
 * and a job pins its bundle for life, so both shapes keep arriving at the
 * dashboard forever. The branch between them belongs here, made once against
 * the RECORDED shape — never against the app or bundle version, which says
 * nothing about the shape of a step inside a run.
 *
 * Pure and DOM-free on purpose: the review inspector's diff imports it, and
 * that logic is compiled and run by `node --test`.
 */
import { COT_STEP_PARTS, isCotStepParts } from "@brainstorm-agentic/protocol";
import type { CotStepPart, CotStepView } from "@brainstorm-agentic/protocol";

/**
 * A part's name on screen. "part1" reads as "part 1" because the number IS
 * the whole label: the parts carry no assigned meaning, so anything more
 * would promise the reader a distinction the run never made.
 */
export function partLabel(part: CotStepPart): string {
  return `part ${part.slice("part".length)}`;
}

/** One rendered block of a step: a labelled part, or the whole step. */
export interface StepTextBlock {
  /** Which part this block is; absent when the step was recorded as one string. */
  readonly part?: CotStepPart;
  readonly text: string;
}

/**
 * A step split into the blocks that render it: four labelled parts when the
 * run recorded parts, one unlabelled block when it recorded a single string.
 * Every place a step is drawn builds its bodies from this, so the four blocks
 * are defined once.
 */
export function stepTextBlocks(step: CotStepView): readonly StepTextBlock[] {
  if (!isCotStepParts(step)) return [{ text: step }];
  return COT_STEP_PARTS.map((part) => ({ part, text: step[part] }));
}

/**
 * A step as one block of plain text, for the clipboard: the parts in order,
 * a blank line between them. A pasted bug report is prose, not a form, so the
 * part labels are dropped here — the boundaries survive as paragraph breaks.
 */
export function stepPlainText(step: CotStepView): string {
  return stepTextBlocks(step)
    .map((block) => block.text)
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}
