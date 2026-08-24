/**
 * Two-sided word diff for OUTPUT change tracking: one ordered stream of
 * kept / added / removed runs, so a reader sees deletions struck through in
 * place instead of silently losing them.
 *
 * The chain deck's diff (apps/web review-diff) marks only what the LATER
 * version changed — deletions there are implied by the paging. The output
 * tracker compares versions far apart (latest against first, and each
 * revision against the one before it in the downloadable document), where
 * "what disappeared" is half the story, so both sides ride one alignment.
 *
 * Lives in protocol because BOTH ends render it: the web's Changes tab and
 * the server's downloadable change document. Two diff implementations would
 * disagree about what changed.
 *
 * Guarantees:
 *  - concatenating the kept and added segments (skipping removed ones)
 *    reproduces `after` character for character;
 *  - a removed segment carries its own spacing (a single leading space when
 *    the text before it does not already end in whitespace), so renderers
 *    can emit segments verbatim in order.
 */

export type InlineDiffKind = "kept" | "added" | "removed";

export interface InlineDiffSegment {
  readonly kind: InlineDiffKind;
  readonly text: string;
}

/**
 * LCS table ceiling, same figure the chain diff uses. Output sections are a
 * few hundred to a few thousand words, far under it; a pathological section
 * past the budget degrades to "everything changed" (one removed run, one
 * added run) rather than an unbounded table.
 */
const CELL_BUDGET = 4_000_000;

interface Token {
  readonly key: string;
  readonly start: number;
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
 * Marks the tokens both sides KEEP, from one shared alignment: common prefix
 * and suffix in linear time, exact LCS for what remains while its table fits
 * the budget. Kept counts are equal on both sides by construction — the
 * merge below walks them in lockstep.
 */
function markBoth(
  b: readonly Token[],
  a: readonly Token[],
  keptB: Uint8Array,
  keptA: Uint8Array,
): void {
  let b0 = 0;
  let a0 = 0;
  let b1 = b.length;
  let a1 = a.length;
  while (b0 < b1 && a0 < a1 && b[b0]!.key === a[a0]!.key) {
    keptB[b0] = 1;
    keptA[a0] = 1;
    b0 += 1;
    a0 += 1;
  }
  while (b1 > b0 && a1 > a0 && b[b1 - 1]!.key === a[a1 - 1]!.key) {
    keptB[b1 - 1] = 1;
    keptA[a1 - 1] = 1;
    b1 -= 1;
    a1 -= 1;
  }
  const m = b1 - b0;
  const n = a1 - a0;
  if (m === 0 || n === 0 || m * n > CELL_BUDGET) return;
  const cols = n + 1;
  const table = new Uint16Array((m + 1) * cols);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      table[i * cols + j] =
        b[b0 + i - 1]!.key === a[a0 + j - 1]!.key
          ? table[(i - 1) * cols + (j - 1)]! + 1
          : Math.max(table[(i - 1) * cols + j]!, table[i * cols + (j - 1)]!);
    }
  }
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (b[b0 + i - 1]!.key === a[a0 + j - 1]!.key) {
      keptB[b0 + i - 1] = 1;
      keptA[a0 + j - 1] = 1;
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * cols + j]! >= table[i * cols + (j - 1)]!) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
}

export function diffInline(
  before: string,
  after: string,
): readonly InlineDiffSegment[] {
  const b = tokensOf(before);
  const a = tokensOf(after);
  const keptB = new Uint8Array(b.length);
  const keptA = new Uint8Array(a.length);
  markBoth(b, a, keptB, keptA);

  const segments: InlineDiffSegment[] = [];
  /** The last character emitted so far, for a removed run's own spacing. */
  let lastChar = "";
  const push = (kind: InlineDiffKind, text: string) => {
    if (text.length === 0) return;
    segments.push({ kind, text });
    lastChar = text[text.length - 1]!;
  };
  /** After-side runs are exact slices reaching the NEXT after-token. */
  const afterSlice = (fromToken: number, toToken: number): string =>
    after.slice(
      a[fromToken]!.start,
      toToken < a.length ? a[toToken]!.start : after.length,
    );

  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    // Removed words first — the classic inline order: old text out, new in.
    if (i < b.length && keptB[i] === 0) {
      const from = i;
      while (i < b.length && keptB[i] === 0) i += 1;
      const span = before.slice(
        b[from]!.start,
        b[i - 1]!.start + b[i - 1]!.key.length,
      );
      push("removed", /\s$/.test(lastChar) || lastChar === "" ? span : ` ${span}`);
      continue;
    }
    if (j < a.length && keptA[j] === 0) {
      const from = j;
      while (j < a.length && keptA[j] === 0) j += 1;
      push("added", afterSlice(from, j));
      continue;
    }
    // Both cursors stand on kept tokens; they pair up in lockstep because
    // both marks come from the same alignment.
    const from = j;
    while (i < b.length && j < a.length && keptB[i] === 1 && keptA[j] === 1) {
      i += 1;
      j += 1;
    }
    push("kept", afterSlice(from, j));
  }
  // A removed run also needs its TRAILING space when the after-text resumes
  // with a word — the slice before it already consumed the whitespace the
  // two would otherwise share ("x [A]y" must read "x [A] y").
  for (let k = 0; k < segments.length; k += 1) {
    const segment = segments[k]!;
    const next = segments[k + 1];
    if (
      segment.kind === "removed" &&
      next !== undefined &&
      !/^\s/.test(next.text) &&
      !/\s$/.test(segment.text)
    ) {
      segments[k] = { kind: "removed", text: `${segment.text} ` };
    }
  }
  return segments;
}

/** True when the two texts differ by at least one word. */
export function hasInlineChanges(segments: readonly InlineDiffSegment[]): boolean {
  return segments.some((segment) => segment.kind !== "kept");
}
