/**
 * Pure change-tracking logic for the review inspector.
 *
 * A redevelopment at walk position n re-emits the COMPLETE chain, so one
 * round's change-set can touch step n itself AND any other step. The round
 * cards render the text that came OUT of each round with two treatments:
 *
 *  - the step's own words that survived from earlier versions render dimmed,
 *    so what this round actually changed carries the full weight;
 *  - a change the round applied to ANOTHER step becomes that step's own
 *    extra "round" card (a cross rewrite), labeled with the walk position
 *    that caused it, its changed words colored by direction.
 *
 * The deck's BASE is the step's first-pass text — the "Original thought"
 * card — which is the only card that renders at full weight in its
 * entirety; every later card's full-weight (or colored) words are exactly
 * what that card changed, and a round that changed nothing renders fully
 * dimmed.
 *
 * All of it derives from a single chronological replay of the seat's walk:
 * steps ascending, rounds ascending — exactly the order the runtime executed
 * them — threading a working chain seeded from the first-pass text.
 */
import type {
  ReviewMemberView,
  ReviewRoundView,
  ReviewStepView,
} from "@brainstorm-agentic/protocol";

export interface DiffSegment {
  readonly text: string;
  /** True when this run of words is new in the compared version. */
  readonly changed: boolean;
}

/**
 * Word-level diff: tokens of `after` that also appear (in order) in `before`
 * are "kept", everything else is "changed". Classic LCS over whitespace
 * tokens, merged into runs so the DOM stays small. Step texts are single
 * paragraphs, so the quadratic table stays tiny; pathological inputs fall
 * back to one changed segment rather than an O(n·m) blowup.
 */
const MAX_DIFF_TOKENS = 1200;

export function diffWords(before: string | undefined, after: string): readonly DiffSegment[] {
  const b = tokenize(before ?? "");
  const a = tokenize(after);
  if (a.length === 0) return [];
  if (b.length === 0 || a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) {
    return [{ text: after, changed: true }];
  }
  // LCS length table (b rows × a columns), then walk back marking kept tokens.
  const rows = b.length + 1;
  const cols = a.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i * cols + j] =
        b[i - 1] === a[j - 1]
          ? table[(i - 1) * cols + (j - 1)]! + 1
          : Math.max(table[(i - 1) * cols + j]!, table[i * cols + (j - 1)]!);
    }
  }
  const kept = new Array<boolean>(a.length).fill(false);
  let i = b.length;
  let j = a.length;
  while (i > 0 && j > 0) {
    if (b[i - 1] === a[j - 1]) {
      kept[j - 1] = true;
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * cols + j]! >= table[i * cols + (j - 1)]!) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  const segments: DiffSegment[] = [];
  for (let k = 0; k < a.length; k += 1) {
    const changed = !kept[k];
    const last = segments[segments.length - 1];
    if (last !== undefined && last.changed === changed) {
      segments[segments.length - 1] = { text: `${last.text} ${a[k]!}`, changed };
    } else {
      segments.push({ text: a[k]!, changed });
    }
  }
  return segments;
}

function tokenize(text: string): readonly string[] {
  const trimmed = text.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

/** One retroactive rewrite a round applied to a step other than its own. */
export interface CrossChangeView {
  /** 1-based index of the step the rewrite landed on. */
  readonly index: number;
  /** The step's text before this rewrite; undefined when unreconstructable. */
  readonly before?: string;
  readonly after: string;
  readonly segments: readonly DiffSegment[];
}

/** Everything a round card needs, derived once per seat. */
export interface RoundComputedView {
  readonly round: ReviewRoundView;
  /** The step's text as it went INTO this round. */
  readonly inText?: string;
  /** The step's text as it came OUT of this round (own rewrite applied). */
  readonly outText?: string;
  /** True when this round's redevelopment rewrote the step's own text. */
  readonly ownRewrite: boolean;
  /**
   * The out-text as diff segments. A round without a rewrite is all-kept
   * (nothing changed this round — the full-weight debut of the text belongs
   * to the "Original thought" base card); a rewrite diffs against the
   * in-text.
   */
  readonly segments: readonly DiffSegment[];
  /** Rewrites this round applied to OTHER steps, in change-set order. */
  readonly crossChanges: readonly CrossChangeView[];
}

/**
 * One rewrite ANOTHER walk position's round applied to this step — rendered
 * as its own card in the affected step's round deck, in chronological
 * position, labeled with the origin.
 */
export interface CrossRewriteView {
  /** 1-based walk position whose review round produced the rewrite. */
  readonly byStep: number;
  readonly byRound: number;
  /** The step's text before this rewrite; undefined when unreconstructable. */
  readonly before?: string;
  readonly after: string;
  readonly segments: readonly DiffSegment[];
}

export interface SeatTimeline {
  /** Keyed `<stepIndex>:<round>`. */
  readonly rounds: ReadonlyMap<string, RoundComputedView>;
  /**
   * Per step index: rewrites applied to it by OTHER walk positions, in walk
   * order (the order the runtime executed them).
   */
  readonly crossRewrites: ReadonlyMap<number, readonly CrossRewriteView[]>;
  /**
   * Per step index: the first-pass text — the "Original thought" every later
   * version is ultimately measured against. Absent when the run carries no
   * first-pass record (older artifacts), in which case the deck simply has
   * no base card.
   */
  readonly original: ReadonlyMap<number, string>;
  /** The chain as the replay leaves it (first pass + every rewrite). */
  readonly chain: ReadonlyMap<number, string>;
}

export function roundViewKey(stepIndex: number, round: number): string {
  return `${stepIndex}:${round}`;
}

/**
 * Replays the seat's walk chronologically and precomputes every round card's
 * texts, diffs, and cross-step changes. `firstPassCot` (1-based via index+1)
 * seeds the chain so a rewrite that lands on a not-yet-reviewed step still
 * has a before-text to diff against.
 */
export function computeSeatTimeline(
  member: ReviewMemberView,
  firstPassCot?: readonly string[],
): SeatTimeline {
  const chain = new Map<number, string>();
  const original = new Map<number, string>();
  (firstPassCot ?? []).forEach((text, index) => {
    chain.set(index + 1, text);
    original.set(index + 1, text);
  });
  const rounds = new Map<string, RoundComputedView>();
  const crossRewrites = new Map<number, CrossRewriteView[]>();

  const steps = [...member.steps].sort((a, b) => a.index - b.index);
  for (const step of steps) {
    const ordered = [...step.rounds].sort((a, b) => a.round - b.round);
    for (const round of ordered) {
      // The recorded under-review text is authoritative for what stood at
      // this moment (it already carries every earlier rewrite).
      const inText = round.cot ?? chain.get(step.index);
      if (inText !== undefined) chain.set(step.index, inText);

      const rewritten = round.revision?.rewritten ?? [];
      const own = rewritten.find((entry) => entry.index === step.index);
      const outText = own?.text ?? inText;

      const crossChanges: CrossChangeView[] = [];
      for (const entry of rewritten) {
        if (entry.index === step.index) continue;
        const before = chain.get(entry.index);
        const segments = diffWords(before, entry.text);
        crossChanges.push({
          index: entry.index,
          ...(before !== undefined ? { before } : {}),
          after: entry.text,
          segments,
        });
        chain.set(entry.index, entry.text);
        // The affected step's own record of the same event: an extra card in
        // its round deck, carrying who caused it and the text it left behind.
        const received = crossRewrites.get(entry.index) ?? [];
        received.push({
          byStep: step.index,
          byRound: round.round,
          ...(before !== undefined ? { before } : {}),
          after: entry.text,
          segments,
        });
        crossRewrites.set(entry.index, received);
      }
      if (outText !== undefined) chain.set(step.index, outText);

      // A round without a rewrite is all-kept: the text's full-weight debut
      // belongs to the "Original thought" base card, so a round card's
      // full-weight words always mean "this round changed them".
      const segments: readonly DiffSegment[] =
        outText === undefined
          ? []
          : own !== undefined
            ? diffWords(inText, outText)
            : [{ text: outText, changed: false }];

      rounds.set(roundViewKey(step.index, round.round), {
        round,
        ...(inText !== undefined ? { inText } : {}),
        ...(outText !== undefined ? { outText } : {}),
        ownRewrite: own !== undefined,
        segments,
        crossChanges,
      });
    }
  }
  return { rounds, crossRewrites, original, chain };
}

/**
 * One entry of a step's round deck: the step's first-pass base text (the
 * "Original thought"), a real review round, or a rewrite that ANOTHER walk
 * position's round applied to this step — each its own card, so paging the
 * deck reads the step's full text history in the order it happened.
 */
/**
 * One card of a step's deck: a VERSION of the step's text, plus the review
 * performed ON that version. For a round entry, `round` is the round that
 * WROTE the text and `review` the round that then read it — a different
 * round, because a round comments before it redevelops.
 */
export type DeckEntry = { readonly review?: ReviewRoundView } & (
  | { readonly kind: "original"; readonly key: string; readonly text: string }
  | { readonly kind: "round"; readonly key: string; readonly round: ReviewRoundView }
  | { readonly kind: "cross"; readonly key: string; readonly cross: CrossRewriteView }
);

/**
 * The deck in chronological order. Walk order IS the chronology: the
 * original thought first, then rewrites from EARLIER positions (they landed
 * before this step's own review began), the step's own rounds, and rewrites
 * from LATER positions; within each side the timeline replay already
 * ordered them. The base card only joins a deck that has something to
 * compare against it — a step nothing has touched keeps its pending card.
 */
export function deckEntries(step: ReviewStepView, timeline: SeatTimeline): DeckEntry[] {
  const crosses = timeline.crossRewrites.get(step.index) ?? [];
  const crossEntry = (view: CrossRewriteView): DeckEntry => ({
    kind: "cross",
    key: `x${view.byStep}:${view.byRound}`,
    cross: view,
  });
  const rounds = [...step.rounds]
    .sort((a, b) => a.round - b.round)
    .map((round): DeckEntry => ({ kind: "round", key: `r${round.round}`, round }));
  const entries: DeckEntry[] = [
    ...crosses.filter((view) => view.byStep < step.index).map(crossEntry),
    ...rounds,
    ...crosses.filter((view) => view.byStep > step.index).map(crossEntry),
  ];
  const original = timeline.original.get(step.index);
  if (entries.length > 0 && original !== undefined) {
    entries.unshift({ kind: "original", key: "original", text: original });
  }
  // Attach each version's reviewer BEFORE anything is dropped: the deck is
  // chronological, so the round that read a version is the next entry that
  // is a round.
  const withReview = entries.map((entry, index) => {
    const next = entries[index + 1];
    return next?.kind === "round" ? { ...entry, review: next.round } : entry;
  });

  // A round that wrote no new version of THIS step gets no card of its own —
  // its review rides the version it actually read. The last round of a
  // position never redevelops (it either passed or hit the cap), so without
  // this the deck always ended on a card repeating the previous text with
  // nothing of its own to show.
  return withReview.filter((entry) => {
    if (entry.kind !== "round") return true;
    const computed = timeline.rounds.get(roundViewKey(step.index, entry.round.round));
    return computed?.ownRewrite === true || entry.review !== undefined;
  });
}

/**
 * The round that reviewed the version a given deck entry shows — the round
 * AFTER the one that wrote it, because a round comments on the text it was
 * handed and only then redevelops. Resolved while the deck is built, so it
 * survives dropping the rounds that wrote no version of this step.
 */
export function reviewedBy(deck: readonly DeckEntry[], index: number): ReviewRoundView | undefined {
  return deck[index]?.review;
}
