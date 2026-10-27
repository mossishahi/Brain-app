/**
 * Deterministic ranking of fact-table entries against a claim: the lookup an
 * agent runs before it submits, and the related entries the supreme judge is
 * shown with every submission. No model is involved — the same table and the
 * same claim always give the same answer, in the same order.
 *
 * Scoring is BM25 over the words of each entry's claim (counted twice: the
 * claim is what an entry asserts) and its conditions. Numbers and identifiers
 * stay whole ("0.42", "n_neighbors", "laplacian.py") so a figure or a file
 * name matches only itself, and a compound identifier also contributes its
 * parts so "laplacian" still finds "laplacian.py". An entry whose normalized
 * claim equals the query's is a same-claim match and ranks first.
 */
import type { FactEntry } from "@brainstorm-agentic/core";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can", "could", "do", "does",
  "for", "from", "has", "have", "if", "in", "into", "is", "it", "its", "may", "might", "of", "on",
  "or", "so", "such", "than", "that", "the", "their", "then", "there", "these", "this", "those",
  "to", "under", "was", "were", "when", "where", "which", "while", "with", "within", "would",
]);

const K1 = 1.2;
const B = 0.75;

/** Lower case, single spaces, no trailing sentence punctuation: the form two claims are compared in. */
export function normalizeFactText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.;:,!]+$/, "").trim();
}

/** The searchable words of a text: whole tokens, plus the parts of compound identifiers. */
export function factTokens(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9_]+(?:[.\-/][a-z0-9_]+)*/g) ?? [];
  const tokens: string[] = [];
  for (const token of raw) {
    if (!STOPWORDS.has(token)) tokens.push(token);
    if (/[.\-/]/.test(token) && !/^\d+(?:\.\d+)?$/.test(token)) {
      for (const part of token.split(/[.\-/]/)) {
        if (part.length > 1 && !STOPWORDS.has(part)) tokens.push(part);
      }
    }
  }
  return tokens;
}

export interface RankedFact {
  readonly entry: FactEntry;
  readonly score: number;
  /** The entry's normalized claim equals the query's. Its conditions may still differ. */
  readonly sameClaim: boolean;
}

function idNumber(id: string): number {
  const match = /^F:(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * The entries closest to `query`, best first, at most `limit` of them. Only
 * entries sharing at least one word with the query (or stating the same
 * claim) are returned. Ties keep the older entry first.
 */
export function rankFacts(
  entries: readonly FactEntry[],
  query: { readonly claim: string; readonly conditions?: string },
  limit: number,
): readonly RankedFact[] {
  if (limit <= 0 || entries.length === 0) return [];
  const queryTerms = [...new Set(factTokens(`${query.claim} ${query.conditions ?? ""}`))];
  const sameKey = normalizeFactText(query.claim);
  const documents = entries.map((entry) => {
    const tokens = [...factTokens(entry.claim), ...factTokens(entry.claim), ...factTokens(entry.conditions)];
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    return { entry, frequencies, length: tokens.length };
  });
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(term, documents.filter((doc) => doc.frequencies.has(term)).length);
  }
  const count = documents.length;
  const ranked: RankedFact[] = [];
  for (const doc of documents) {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = doc.frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      score += (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * doc.length) / averageLength));
    }
    const sameClaim = normalizeFactText(doc.entry.claim) === sameKey && sameKey !== "";
    if (score > 0 || sameClaim) ranked.push({ entry: doc.entry, score, sameClaim });
  }
  ranked.sort(
    (left, right) =>
      Number(right.sameClaim) - Number(left.sameClaim) ||
      right.score - left.score ||
      idNumber(left.entry.id) - idNumber(right.entry.id),
  );
  return ranked.slice(0, limit);
}
