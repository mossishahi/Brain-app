/**
 * The searchable form of one seat's notes inside one review scope.
 *
 * Traces are cut into paragraphs (the thinker's own blank-line breaks) and
 * paragraphs into sentences, each paragraph attributed to the chain step it
 * was written toward: the thinking recorded between two submitted steps was
 * done while working on the later one. Everything a trace recorded AFTER it
 * submitted the step under review is left out — a reviewer at step k has
 * not been shown steps k+1.. and must not read the thinking behind them.
 * The thinking written after a trace's LAST step (while the result body was
 * being written) is shown only to a reviewer who has reached that step.
 *
 * Ids are stable for the scope and readable: `F:14` is the first pass's
 * 14th paragraph, `R2:3` the third paragraph of the second redevelopment,
 * `F:14#2` the second sentence of F:14.
 */
import type { NoteTrace, NotesScope } from "@brainstorm-agentic/core";

export interface NoteParagraph {
  readonly id: string;
  /** "first pass" or "redevelopment N (rewrote steps …)". */
  readonly source: string;
  readonly kind: NoteTrace["kind"];
  readonly order: number;
  /** The chain step the paragraph was written toward; absent = after the last step. */
  readonly step?: number;
  readonly turn: number;
  readonly text: string;
  readonly sentences: readonly string[];
}

export interface NotesIndex {
  readonly scope: NotesScope;
  readonly paragraphs: readonly NoteParagraph[];
  readonly traces: readonly {
    readonly source: string;
    readonly kind: NoteTrace["kind"];
    readonly order: number;
    readonly rewrote?: readonly number[];
    readonly steps: readonly number[];
    readonly visibleChars: number;
    readonly hiddenChars: number;
    readonly paragraphs: number;
  }[];
}

/** Abbreviations a period does not end a sentence after. */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|cf|vs|etc|al|fig|figs|eq|eqs|sec|ch|no|vol|pp|approx|dr|prof|mr|ms|mrs|st|jr|sr|resp|viz|ca)\.$/i;

/** Splits prose into sentences; list items and short lines stay whole. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const pieces = trimmed.split(/(?<=[.!?][)"'\u201d\u2019]?)\s+(?=[("'\u201c\u2018A-Z0-9\u00c0-\u024f])/);
    let current = "";
    for (const piece of pieces) {
      current = current === "" ? piece : `${current} ${piece}`;
      // Re-join a split that only followed an abbreviation or an initial.
      if (ABBREVIATIONS.test(current) || /\b[A-Z]\.$/.test(current)) continue;
      out.push(current);
      current = "";
    }
    if (current !== "") out.push(current);
  }
  return out;
}

export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

function traceLabel(trace: NoteTrace): string {
  if (trace.kind === "first-pass") return "first pass";
  const rewrote = trace.rewrote ?? [];
  return `redevelopment ${trace.order}${rewrote.length > 0 ? ` (rewrote step${rewrote.length > 1 ? "s" : ""} ${rewrote.join(", ")})` : ""}`;
}

export function idPrefix(trace: Pick<NoteTrace, "kind" | "order">): string {
  return trace.kind === "first-pass" ? "F" : `R${trace.order}`;
}

/** Builds the index of one seat's traces inside a scope. */
export function buildNotesIndex(traces: readonly NoteTrace[], scope: NotesScope): NotesIndex {
  const paragraphs: NoteParagraph[] = [];
  const summaries: NotesIndex["traces"][number][] = [];
  for (const trace of [...traces].sort((a, b) => a.order - b.order)) {
    const steps = [...trace.stepTurns].sort((a, b) => a.turn - b.turn || a.index - b.index);
    const shownSteps = steps.filter((step) => step.index <= scope.throughStep);
    const lastStep = steps[steps.length - 1];
    const reachedEnd = lastStep !== undefined && lastStep.index <= scope.throughStep;
    // Nothing submitted inside the scope: a repair of later steps only — its
    // thinking is about text the reviewer has not been shown.
    const cutoff = shownSteps.length > 0 ? Math.max(...shownSteps.map((step) => step.turn)) : steps.length === 0 ? Number.POSITIVE_INFINITY : -1;
    const source = traceLabel(trace);
    const prefix = idPrefix(trace);
    let count = 0;
    let visible = 0;
    let hidden = 0;
    for (const segment of trace.segments) {
      const shown = segment.turn <= cutoff || (reachedEnd && segment.turn > lastStep!.turn);
      if (!shown) {
        hidden += segment.text.length;
        continue;
      }
      visible += segment.text.length;
      const toward = steps.find((step) => step.turn >= segment.turn);
      for (const text of paragraphsOf(segment.text)) {
        count += 1;
        paragraphs.push({
          id: `${prefix}:${count}`,
          source,
          kind: trace.kind,
          order: trace.order,
          ...(toward !== undefined ? { step: toward.index } : {}),
          turn: segment.turn,
          text,
          sentences: splitSentences(text),
        });
      }
    }
    summaries.push({
      source,
      kind: trace.kind,
      order: trace.order,
      ...(trace.rewrote !== undefined ? { rewrote: trace.rewrote } : {}),
      steps: [...new Set(steps.map((step) => step.index))].sort((a, b) => a - b),
      visibleChars: visible,
      hiddenChars: hidden,
      paragraphs: count,
    });
  }
  return { scope, paragraphs, traces: summaries };
}
