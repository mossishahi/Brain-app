/**
 * The MAIN section of a seat's output as flat, labelled text — the one
 * projection both change trackers diff: the web's Changes tab (latest
 * against first) and the server's downloadable change document (each
 * revision against the one before it). Two projections would report two
 * different sets of changes for the same edit.
 *
 * "Main section" means the shape body alone — the paper, the solution, the
 * survey… — never the chain, the novelty claim, or the literature record:
 * those have trackers and views of their own.
 *
 * The walk is GENERIC over the body's fields rather than one hand-written
 * mirror per shape: labels derive from the field names the schema already
 * carries, values flatten by structure (strings stand, arrays stack one item
 * per line, objects join their values). A new shape in a future bundle is
 * tracked the day it ships, and the projection cannot drift out of sync with
 * a renderer it never copied.
 */

export interface OutputSectionView {
  readonly label: string;
  readonly text: string;
}

/**
 * One tracked version of a seat's main section. Step and round address the
 * review moment that produced it (the deck's own coordinates); the first
 * pass is version zero on both counts.
 */
export interface OutputVersionView {
  /** 1-based chain step whose review produced this version; 0 = first pass. */
  readonly step: number;
  /** 1-based review round within that step; 0 = first pass. */
  readonly round: number;
  readonly sections: readonly OutputSectionView[];
}

/** The idea fields that can carry the shape body, in render precedence. */
const BODY_FIELDS = [
  "paper",
  "resolution",
  "verification",
  "feasibility",
  "critique",
  "interpretation",
  "survey",
  "explanation",
  "solution",
] as const;

/** Structural carrier: every idea view satisfies it, none depends on it. */
export type OutputBodyCarrier = {
  readonly [K in (typeof BODY_FIELDS)[number]]?: unknown;
};

/** "problemFraming" -> "Problem framing". */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A value as diffable text. Strings stand as written; arrays stack their
 * items (a string item is a paragraph, an object item one line of its
 * values); a nested object joins its values with an em dash, so a table row
 * like {attempt, outcome} reads "attempt — outcome".
 */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => flatten(item))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value)
      .map((item) => flatten(item))
      .filter((text) => text.length > 0)
      .join(" — ");
  }
  return "";
}

/**
 * The main section of one idea view, one entry per body field that carries
 * text, in the body's own field order. Empty when the idea has no shape body
 * (a malformed or half-recorded artifact).
 */
export function outputSections(
  idea: OutputBodyCarrier,
): readonly OutputSectionView[] {
  const body = BODY_FIELDS.map((field) => idea[field]).find(
    (candidate) => typeof candidate === "object" && candidate !== null,
  );
  if (body === undefined) return [];
  return Object.entries(body as Record<string, unknown>).flatMap(
    ([key, value]) => {
      const text = flatten(value);
      return text.length > 0 ? [{ label: humanize(key), text }] : [];
    },
  );
}
