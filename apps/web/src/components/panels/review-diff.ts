/**
 * Pure change-tracking logic for the review inspector.
 *
 * A redevelopment at walk position n delivers a PATCH that may name any step
 * of the chain, so one round's change-set can touch step n itself AND any
 * other step — later positions included. The round
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
 * Word-level diff between two versions of one step.
 *
 * Tokens of `after` that also appear (in order) in `before` are "kept",
 * everything else is "changed". Each segment is an exact slice of `after` —
 * the whitespace after a token travels with it — so concatenating every
 * segment reproduces `after` character for character.
 *
 * Cost is controlled in three stages, cheapest first:
 *
 *  1. the common prefix and suffix are matched off in linear time (successive
 *     versions of a step share hundreds of leading tokens verbatim);
 *  2. what remains gets the exact LCS while its table fits CELL_BUDGET;
 *  3. past that the two sides are cut into clauses, the LCS runs over whole
 *     clauses — a table smaller by the square of the clause length — and the
 *     gap between each pair of matched clauses is then diffed word by word.
 *
 * A flat token ceiling used to sit here instead, and above it every card
 * rendered as one fully-changed run: no dimming, which reads as no diff at
 * all. A step's text carries no length limit and grows with every
 * redevelopment, so that ceiling gave up on exactly the late-round versions
 * whose changes a reader most needs marked out.
 */
const CELL_BUDGET = 4_000_000;

/** Tokens per clause in the anchored fallback (stage 3). */
const CLAUSE_TARGET = 24;

interface Token {
  readonly key: string;
  /** Offset of the token in its source text. */
  readonly start: number;
}

/** One token range of a side, as the anchored pass groups them. */
interface Clause {
  readonly key: string;
  /** Token index of the first token, and one past the last. */
  readonly from: number;
  readonly to: number;
}

export function diffWords(before: string | undefined, after: string): readonly DiffSegment[] {
  const a = tokensOf(after);
  if (a.length === 0) return [];
  const b = tokensOf(before ?? "");
  const kept = new Uint8Array(a.length);
  if (b.length > 0) markKept(b, a, 0, b.length, 0, a.length, kept);
  return segmentsOf(after, a, kept);
}

function tokensOf(text: string): readonly Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  let match = pattern.exec(text);
  while (match !== null) {
    tokens.push({ key: match[0], start: match.index });
    match = pattern.exec(text);
  }
  return tokens;
}

/**
 * Marks every token of `a[a0,a1)` that survives from `b[b0,b1)`, choosing the
 * stage by how large the remaining problem is. Recursion is always into a
 * strictly smaller range — the anchored pass only recurses when it matched at
 * least one non-empty clause — so it terminates.
 */
function markKept(
  b: readonly Token[],
  a: readonly Token[],
  b0: number,
  b1: number,
  a0: number,
  a1: number,
  kept: Uint8Array,
): void {
  let bFrom = b0;
  let aFrom = a0;
  let bTo = b1;
  let aTo = a1;
  while (bFrom < bTo && aFrom < aTo && b[bFrom]!.key === a[aFrom]!.key) {
    kept[aFrom] = 1;
    bFrom += 1;
    aFrom += 1;
  }
  while (bTo > bFrom && aTo > aFrom && b[bTo - 1]!.key === a[aTo - 1]!.key) {
    kept[aTo - 1] = 1;
    bTo -= 1;
    aTo -= 1;
  }
  const n = aTo - aFrom;
  const m = bTo - bFrom;
  // Nothing left on one side: whatever remains of `a` is new by definition.
  if (n === 0 || m === 0) return;
  if (n * m <= CELL_BUDGET) {
    markKeptExact(b, a, bFrom, bTo, aFrom, aTo, kept);
    return;
  }
  markKeptAnchored(b, a, bFrom, bTo, aFrom, aTo, kept);
}

/**
 * Classic LCS table over the two token ranges, walked back to mark the kept
 * tokens. The cell budget bounds the shorter side well under 65_535, so the
 * table's counts always fit a Uint16.
 */
function markKeptExact(
  b: readonly Token[],
  a: readonly Token[],
  b0: number,
  b1: number,
  a0: number,
  a1: number,
  kept: Uint8Array,
): void {
  const rows = b1 - b0 + 1;
  const cols = a1 - a0 + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i * cols + j] =
        b[b0 + i - 1]!.key === a[a0 + j - 1]!.key
          ? table[(i - 1) * cols + (j - 1)]! + 1
          : Math.max(table[(i - 1) * cols + j]!, table[i * cols + (j - 1)]!);
    }
  }
  let i = rows - 1;
  let j = cols - 1;
  while (i > 0 && j > 0) {
    if (b[b0 + i - 1]!.key === a[a0 + j - 1]!.key) {
      kept[a0 + j - 1] = 1;
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * cols + j]! >= table[i * cols + (j - 1)]!) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
}

/**
 * The fallback for ranges too large to align word by word: match whole
 * clauses first (a table CLAUSE_TARGET² smaller), then diff each gap between
 * two matched clauses on its own. Two versions of a step share long stretches
 * verbatim, so the clauses anchor densely and every gap is small.
 */
function markKeptAnchored(
  b: readonly Token[],
  a: readonly Token[],
  b0: number,
  b1: number,
  a0: number,
  a1: number,
  kept: Uint8Array,
): void {
  // Clause length scales with the problem, so the clause table itself always
  // fits the same budget however long the two versions are.
  const target = Math.max(
    CLAUSE_TARGET,
    Math.ceil(Math.sqrt(((b1 - b0) * (a1 - a0)) / CELL_BUDGET)),
  );
  const bClauses = clausesOf(b, b0, b1, target);
  const aClauses = clausesOf(a, a0, a1, target);
  const pairs = matchedPairs(
    bClauses.map((clause) => clause.key),
    aClauses.map((clause) => clause.key),
  );
  // No clause in common: the range shares nothing worth anchoring on, and
  // every token of it is already marked changed.
  if (pairs.length === 0) return;
  let bCursor = b0;
  let aCursor = a0;
  for (const [bIndex, aIndex] of pairs) {
    const bClause = bClauses[bIndex]!;
    const aClause = aClauses[aIndex]!;
    if (aClause.from > aCursor) {
      markKept(b, a, bCursor, bClause.from, aCursor, aClause.from, kept);
    }
    for (let k = aClause.from; k < aClause.to; k += 1) kept[k] = 1;
    bCursor = bClause.to;
    aCursor = aClause.to;
  }
  if (aCursor < a1) markKept(b, a, bCursor, b1, aCursor, a1, kept);
}

/**
 * Cuts a token range into clauses of roughly `target` tokens, preferring to
 * break where the prose does (a token ending in sentence or clause
 * punctuation) so the same clause text recurs across versions. A clause that
 * finds no break by twice the target is cut anyway.
 */
function clausesOf(
  tokens: readonly Token[],
  from: number,
  to: number,
  target: number,
): readonly Clause[] {
  const clauses: Clause[] = [];
  let start = from;
  for (let k = from; k < to; k += 1) {
    const length = k - start + 1;
    const breakable = length >= target && /[.;:?!,]$/.test(tokens[k]!.key);
    if (breakable || length >= target * 2 || k === to - 1) {
      clauses.push({ key: keyOf(tokens, start, k + 1), from: start, to: k + 1 });
      start = k + 1;
    }
  }
  return clauses;
}

function keyOf(tokens: readonly Token[], from: number, to: number): string {
  const parts: string[] = [];
  for (let k = from; k < to; k += 1) parts.push(tokens[k]!.key);
  return parts.join(" ");
}

/** LCS over two key arrays, as the matched (before, after) index pairs. */
function matchedPairs(b: readonly string[], a: readonly string[]): readonly [number, number][] {
  const rows = b.length + 1;
  const cols = a.length + 1;
  if (b.length * a.length > CELL_BUDGET) return [];
  const table = new Uint32Array(rows * cols);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i * cols + j] =
        b[i - 1] === a[j - 1]
          ? table[(i - 1) * cols + (j - 1)]! + 1
          : Math.max(table[(i - 1) * cols + j]!, table[i * cols + (j - 1)]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = b.length;
  let j = a.length;
  while (i > 0 && j > 0) {
    if (b[i - 1] === a[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * cols + j]! >= table[i * cols + (j - 1)]!) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs.reverse();
}

/**
 * The marked tokens as runs, each run an exact slice of the source: a run
 * reaches to the start of the next run's first token, so the whitespace
 * between two words is never rebuilt by the renderer and a version's own
 * spacing survives paging through the deck.
 */
function segmentsOf(
  text: string,
  tokens: readonly Token[],
  kept: Uint8Array,
): readonly DiffSegment[] {
  const segments: DiffSegment[] = [];
  let runStart = 0;
  let runChanged = kept[0] === 0;
  for (let k = 0; k < tokens.length; k += 1) {
    const changed = kept[k] === 0;
    if (changed === runChanged) continue;
    segments.push({ text: text.slice(runStart, tokens[k]!.start), changed: runChanged });
    runStart = tokens[k]!.start;
    runChanged = changed;
  }
  segments.push({ text: text.slice(runStart), changed: runChanged });
  return segments;
}

/**
 * A diff computed only if something reads it, once.
 *
 * The deck shows ONE version at a time, so eagerly diffing every version of
 * every step spends the whole walk's work to render seven cards — and spends
 * it again on the next progress event of a live run.
 */
function lazyDiff(before: string | undefined, after: string): () => readonly DiffSegment[] {
  let cached: readonly DiffSegment[] | undefined;
  return () => (cached ??= diffWords(before, after));
}

function withSegments<T extends object>(
  base: T,
  segments: () => readonly DiffSegment[],
): T & { readonly segments: readonly DiffSegment[] } {
  return Object.defineProperty(base, "segments", {
    enumerable: true,
    get: segments,
  }) as T & { readonly segments: readonly DiffSegment[] };
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

/**
 * The seat's timeline, reused until the seat's own text changes.
 *
 * The review panel re-renders on every progress event of a running job, and
 * a timeline is derived purely from recorded text — so recomputing it per
 * render throws away every diff the reader is currently looking at and does
 * the work again. One entry per seat, keyed by a fingerprint of everything
 * the timeline reads; the fingerprint costs a pass over the seat's text,
 * which is far less than one diff.
 */
const timelineCache = new Map<string, { signature: string; timeline: SeatTimeline }>();

/** Enough seats for any panel; a tab that outlives several jobs starts over. */
const TIMELINE_CACHE_LIMIT = 32;

export function seatTimeline(
  member: ReviewMemberView,
  firstPassCot?: readonly string[],
): SeatTimeline {
  const signature = timelineSignature(member, firstPassCot);
  const hit = timelineCache.get(member.memberId);
  if (hit !== undefined && hit.signature === signature) return hit.timeline;
  const timeline = computeSeatTimeline(member, firstPassCot);
  if (timelineCache.size >= TIMELINE_CACHE_LIMIT) timelineCache.clear();
  timelineCache.set(member.memberId, { signature, timeline });
  return timeline;
}

/**
 * Everything computeSeatTimeline reads, as one string: the walk's shape plus a
 * fingerprint of every text it diffs. Lengths alone would miss a rewrite that
 * happened to preserve them, so the texts are hashed rather than measured.
 */
export function timelineSignature(
  member: ReviewMemberView,
  firstPassCot?: readonly string[],
): string {
  const parts: string[] = [member.memberId, member.dismissed !== undefined ? "dismissed" : ""];
  for (const text of firstPassCot ?? []) parts.push(fingerprint(text));
  for (const step of member.steps) {
    parts.push(`s${step.index}:${step.outcome}`);
    for (const round of step.rounds) {
      parts.push(
        `r${round.round}:${round.decision?.verdict ?? "-"}:${fingerprint(round.cot ?? "")}`,
      );
      for (const entry of round.revision?.rewritten ?? []) {
        parts.push(`w${entry.index}:${fingerprint(entry.text)}`);
      }
    }
  }
  return parts.join("|");
}

/** FNV-1a over the text — a content fingerprint, nothing security-bearing. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The deck key of the card an origin round's rewrite left on ANOTHER step —
 * the one definition, because the origin card links to exactly that card and a
 * second copy of the format would silently link nowhere.
 */
export function crossEntryKey(byStep: number, byRound: number): string {
  return `x${byStep}:${byRound}`;
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
        // One diff, read by whichever of the two cards below is opened first:
        // the origin round's card and the affected step's card show the same
        // change from opposite ends.
        const segments = lazyDiff(before, entry.text);
        crossChanges.push(
          withSegments(
            {
              index: entry.index,
              ...(before !== undefined ? { before } : {}),
              after: entry.text,
            },
            segments,
          ),
        );
        chain.set(entry.index, entry.text);
        // The affected step's own record of the same event: an extra card in
        // its round deck, carrying who caused it and the text it left behind.
        const received = crossRewrites.get(entry.index) ?? [];
        received.push(
          withSegments(
            {
              byStep: step.index,
              byRound: round.round,
              ...(before !== undefined ? { before } : {}),
              after: entry.text,
            },
            segments,
          ),
        );
        crossRewrites.set(entry.index, received);
      }
      if (outText !== undefined) chain.set(step.index, outText);

      const base = {
        round,
        ...(inText !== undefined ? { inText } : {}),
        ...(outText !== undefined ? { outText } : {}),
        ownRewrite: own !== undefined,
        crossChanges,
      };
      // A round without a rewrite is all-kept: the text's full-weight debut
      // belongs to the "Original thought" base card, so a round card's
      // full-weight words always mean "this round changed them".
      rounds.set(
        roundViewKey(step.index, round.round),
        outText === undefined
          ? { ...base, segments: [] }
          : own !== undefined
            ? withSegments(base, lazyDiff(inText, outText))
            : { ...base, segments: [{ text: outText, changed: false }] },
      );
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
export type DeckEntry = {
  readonly review?: ReviewRoundView;
  /**
   * Which EDIT ROUND this card is: the Nth version of the step, whoever wrote it.
   *
   * A step's versions do not come only from its own review — a redevelopment at
   * any position may rewrite it — so numbering only the review loop's iterations
   * put "round 1" on a deck that already showed three edits. One rule for both:
   * every version is a round, counted in the order they happened. Absent on the
   * base card (the first pass is not an edit) and on a round that wrote no
   * version of this step (it is another review of the card before it).
   */
  readonly editRound?: number;
} & (
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
    key: crossEntryKey(view.byStep, view.byRound),
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

  // Number the versions, in the order they happened. A cross rewrite is a
  // version by definition; a round is one only when it rewrote THIS step.
  let version = 0;
  const numbered = withReview.map((entry) => {
    const writesVersion =
      entry.kind === "cross" ||
      (entry.kind === "round" &&
        timeline.rounds.get(roundViewKey(step.index, entry.round.round))?.ownRewrite === true);
    if (!writesVersion) return entry;
    version += 1;
    return { ...entry, editRound: version };
  });

  // A round that wrote no new version of THIS step gets no card of its own —
  // its review rides the version it actually read. The last round of a
  // position never redevelops (it either passed or hit the cap), so without
  // this the deck always ended on a card repeating the previous text with
  // nothing of its own to show.
  return numbered.filter((entry) => {
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
