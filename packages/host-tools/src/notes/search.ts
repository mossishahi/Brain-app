/**
 * The search modes of the notes tool, over a NotesIndex.
 *
 * Every mode answers with bounded JSON: a few result entries, each carrying
 * a paragraph (or sentence) id the model can hand back to `read`, plus
 * `more` when the bound cut the list. Nothing here interprets the notes —
 * the modes find, group and quote the thinker's own sentences.
 */
import type { JsonObject, JsonValue, NotesScope } from "@brainstorm-agentic/core";

import type { NoteParagraph, NotesIndex } from "./index-notes.js";

export const NOTES_MODES = ["find", "outline", "read", "claims", "decisions", "doubts", "overview"] as const;
export type NotesMode = (typeof NOTES_MODES)[number];

export const NOTES_MATCHES = ["all", "any", "phrase", "regex"] as const;
export type NotesMatch = (typeof NOTES_MATCHES)[number];

export const NOTES_UNITS = ["sentence", "paragraph", "window"] as const;
export type NotesUnit = (typeof NOTES_UNITS)[number];

export const NOTES_SOURCES = ["all", "first-pass", "redevelopments"] as const;
export type NotesSourceFilter = (typeof NOTES_SOURCES)[number];

export interface NotesQuery {
  readonly mode: NotesMode;
  readonly query?: string;
  readonly match?: NotesMatch;
  readonly caseSensitive?: boolean;
  readonly unit?: NotesUnit;
  /** Sentences shown on each side of a hit for unit "window". Default 1. */
  readonly context?: number;
  /** A second term that must occur in the same paragraph as the hit. */
  readonly near?: string;
  /** Only paragraphs written toward these chain steps. */
  readonly steps?: readonly number[];
  readonly source?: NotesSourceFilter;
  /** For claims, decisions and doubts: keep only this group. */
  readonly group?: string;
  /** For "read": paragraph or sentence ids. */
  readonly ids?: readonly string[];
  /** For "read": an inclusive range of paragraph ids within one trace. */
  readonly from?: string;
  readonly to?: string;
  readonly offset?: number;
  readonly maxResults?: number;
  readonly maxChars?: number;
}

export class NotesQueryError extends Error {}

const MAX_RESULTS_CEILING = 100;
const MAX_CHARS_CEILING = 24_000;

function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(ceiling, Math.max(1, Math.trunc(value)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The terms of a query: quoted phrases stay whole, other whitespace splits. */
export function termsOf(query: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|\u201c([^\u201d]+)\u201d|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (term !== "") terms.push(term);
  }
  return terms;
}

interface Matcher {
  (text: string): boolean;
  readonly highlight: RegExp | undefined;
}

export function matcherFor(query: string, match: NotesMatch, caseSensitive: boolean): Matcher {
  const flags = caseSensitive ? "" : "i";
  if (match === "regex") {
    let regex: RegExp;
    try {
      regex = new RegExp(query, flags);
    } catch (error) {
      throw new NotesQueryError(`query is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    const test = (text: string) => regex.test(text);
    return Object.assign(test, { highlight: new RegExp(regex.source, `${flags}g`) });
  }
  if (match === "phrase") {
    const regex = new RegExp(escapeRegExp(query.trim()), flags);
    return Object.assign((text: string) => regex.test(text), { highlight: new RegExp(regex.source, `${flags}g`) });
  }
  const terms = termsOf(query);
  if (terms.length === 0) throw new NotesQueryError("query must contain at least one word.");
  const patterns = terms.map((term) => new RegExp(escapeRegExp(term), flags));
  const test =
    match === "any"
      ? (text: string) => patterns.some((pattern) => pattern.test(text))
      : (text: string) => patterns.every((pattern) => pattern.test(text));
  return Object.assign(test, {
    highlight: new RegExp(terms.map(escapeRegExp).join("|"), `${flags}g`),
  });
}

function sourceAllowed(paragraph: NoteParagraph, source: NotesSourceFilter | undefined): boolean {
  if (source === undefined || source === "all") return true;
  return source === "first-pass" ? paragraph.kind === "first-pass" : paragraph.kind === "redevelopment";
}

function stepAllowed(paragraph: NoteParagraph, steps: readonly number[] | undefined): boolean {
  if (steps === undefined || steps.length === 0) return true;
  return paragraph.step !== undefined && steps.includes(paragraph.step);
}

function inScope(index: NotesIndex, query: NotesQuery): NoteParagraph[] {
  return index.paragraphs.filter(
    (paragraph) => sourceAllowed(paragraph, query.source) && stepAllowed(paragraph, query.steps),
  );
}

function where(paragraph: NoteParagraph): JsonObject {
  return {
    id: paragraph.id,
    source: paragraph.source,
    ...(paragraph.step !== undefined ? { towardStep: paragraph.step } : { towardStep: "after the last step" }),
  };
}

function scopeInfo(index: NotesIndex, full = false): JsonObject {
  const visible = index.traces.reduce((sum, trace) => sum + trace.visibleChars, 0);
  return {
    seat: index.scope.seat,
    throughStep: index.scope.throughStep,
    ...(full ? { traces: index.traces.map((trace) => trace.source) } : { traces: index.traces.length }),
    paragraphs: index.paragraphs.length,
    characters: visible,
    ...(index.traces.some((trace) => trace.hiddenChars > 0)
      ? { note: `Thinking recorded after step ${index.scope.throughStep} was submitted is not shown.` }
      : {}),
  };
}

/** Collects entries until the character budget is spent; reports the cut. */
function collect(
  entries: readonly JsonObject[],
  offset: number,
  maxResults: number,
  maxChars: number,
): { readonly results: JsonObject[]; readonly more: boolean; readonly total: number } {
  const results: JsonObject[] = [];
  let chars = 0;
  let index = Math.max(0, offset);
  for (; index < entries.length && results.length < maxResults; index += 1) {
    const entry = entries[index]!;
    const size = JSON.stringify(entry).length;
    if (results.length > 0 && chars + size > maxChars) break;
    results.push(entry);
    chars += size;
  }
  return { results, more: index < entries.length, total: entries.length };
}

function hint(more: boolean, total: number, shown: number, offset: number, what: string): string | undefined {
  if (!more) return undefined;
  return `${total} ${what} matched; showing ${offset + 1}-${offset + shown}. Repeat with offset ${offset + shown}, narrow the query, or raise max_results/max_chars.`;
}

/* ------------------------------------------------------------------------ */
/* find                                                                     */
/* ------------------------------------------------------------------------ */

function find(index: NotesIndex, query: NotesQuery): JsonObject {
  if (query.query === undefined || query.query.trim() === "") {
    throw new NotesQueryError('mode "find" needs a query: words (all must occur), or match "any", "phrase" or "regex".');
  }
  const matcher = matcherFor(query.query, query.match ?? "all", query.caseSensitive === true);
  const nearMatcher =
    query.near !== undefined && query.near.trim() !== ""
      ? matcherFor(query.near, "any", query.caseSensitive === true)
      : undefined;
  const unit = query.unit ?? "sentence";
  const context = bounded(query.context, 1, 5);
  const entries: JsonObject[] = [];
  for (const paragraph of inScope(index, query)) {
    if (nearMatcher !== undefined && !nearMatcher(paragraph.text)) continue;
    if (unit === "paragraph") {
      if (matcher(paragraph.text)) entries.push({ ...where(paragraph), text: paragraph.text });
      continue;
    }
    paragraph.sentences.forEach((sentence, position) => {
      if (!matcher(sentence)) return;
      const base = { ...where(paragraph), id: `${paragraph.id}#${position + 1}` };
      if (unit === "window") {
        const before = paragraph.sentences.slice(Math.max(0, position - context), position).join(" ");
        const after = paragraph.sentences.slice(position + 1, position + 1 + context).join(" ");
        entries.push({
          ...base,
          ...(before !== "" ? { before } : {}),
          text: sentence,
          ...(after !== "" ? { after } : {}),
        });
      } else {
        entries.push({ ...base, text: sentence });
      }
    });
  }
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const picked = collect(entries, offset, bounded(query.maxResults, 20, MAX_RESULTS_CEILING), bounded(query.maxChars, 6_000, MAX_CHARS_CEILING));
  const guidance = hint(picked.more, picked.total, picked.results.length, offset, `${unit}s`);
  return {
    mode: "find",
    scope: scopeInfo(index),
    query: query.query,
    match: query.match ?? "all",
    unit,
    total: picked.total,
    results: picked.results,
    more: picked.more,
    ...(guidance !== undefined ? { hint: guidance } : {}),
    ...(picked.total === 0
      ? {
          hint:
            'Nothing matched. Try match "any" for several terms, a shorter stem (match "regex" with e.g. "optimi[sz]"), or mode "outline" to see what the notes cover.',
        }
      : {}),
  };
}

/* ------------------------------------------------------------------------ */
/* outline / read                                                           */
/* ------------------------------------------------------------------------ */

function lead(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function outline(index: NotesIndex, query: NotesQuery): JsonObject {
  const entries = inScope(index, query).map((paragraph) => ({
    ...where(paragraph),
    chars: paragraph.text.length,
    lead: lead(paragraph.text),
  }));
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const picked = collect(entries, offset, bounded(query.maxResults, 60, 400), bounded(query.maxChars, 9_000, MAX_CHARS_CEILING));
  const guidance = hint(picked.more, picked.total, picked.results.length, offset, "paragraphs");
  return {
    mode: "outline",
    scope: scopeInfo(index),
    total: picked.total,
    results: picked.results,
    more: picked.more,
    ...(guidance !== undefined ? { hint: guidance } : {}),
  };
}

function parseId(id: string): { readonly paragraph: string; readonly sentence?: number } {
  const match = /^([FR]\d*:\d+)(?:#(\d+))?$/.exec(id.trim());
  if (!match) throw new NotesQueryError(`"${id}" is not a notes id; ids look like F:14, R1:3 or F:14#2 (from outline or find results).`);
  return { paragraph: match[1]!, ...(match[2] !== undefined ? { sentence: Number(match[2]) } : {}) };
}

function read(index: NotesIndex, query: NotesQuery): JsonObject {
  const byId = new Map(index.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const wanted: { paragraph: NoteParagraph; sentence?: number }[] = [];
  const missing: string[] = [];
  for (const id of query.ids ?? []) {
    const parsed = parseId(id);
    const paragraph = byId.get(parsed.paragraph);
    if (paragraph === undefined) missing.push(id);
    else wanted.push({ paragraph, ...(parsed.sentence !== undefined ? { sentence: parsed.sentence } : {}) });
  }
  if (query.from !== undefined || query.to !== undefined) {
    const from = parseId(query.from ?? query.to!).paragraph;
    const to = parseId(query.to ?? query.from!).paragraph;
    const [fromPrefix, fromNumber] = [from.split(":")[0]!, Number(from.split(":")[1])];
    const [toPrefix, toNumber] = [to.split(":")[0]!, Number(to.split(":")[1])];
    if (fromPrefix !== toPrefix) throw new NotesQueryError("from and to must name paragraphs of the same trace (same F or R prefix).");
    for (let number = Math.min(fromNumber, toNumber); number <= Math.max(fromNumber, toNumber); number += 1) {
      const paragraph = byId.get(`${fromPrefix}:${number}`);
      if (paragraph !== undefined) wanted.push({ paragraph });
    }
  }
  if (wanted.length === 0 && missing.length === 0) {
    throw new NotesQueryError('mode "read" needs ids (e.g. ["F:14", "F:15#2"]) or a from/to paragraph range.');
  }
  const entries = wanted.map(({ paragraph, sentence }) =>
    sentence !== undefined
      ? {
          ...where(paragraph),
          id: `${paragraph.id}#${sentence}`,
          text: paragraph.sentences[sentence - 1] ?? "",
        }
      : { ...where(paragraph), text: paragraph.text },
  );
  const picked = collect(entries, 0, bounded(query.maxResults, 40, 200), bounded(query.maxChars, 12_000, MAX_CHARS_CEILING));
  return {
    mode: "read",
    scope: scopeInfo(index),
    results: picked.results,
    more: picked.more,
    ...(missing.length > 0 ? { notFound: missing } : {}),
    ...(picked.more ? { hint: "The character budget cut the list; read fewer paragraphs per call or raise max_chars." } : {}),
  };
}

/* ------------------------------------------------------------------------ */
/* claims / decisions / doubts                                               */
/* ------------------------------------------------------------------------ */

const CLAIM_GROUPS: readonly { readonly group: string; readonly pattern: RegExp }[] = [
  {
    group: "assumptions",
    pattern:
      /\b(assum\w*|suppos\w*|presum\w*|take[ns]? .{0,30}\b(as given|for granted)|granted|let'?s say|say that|without loss of generality|for simplicity|approximat\w+|roughly|idealiz\w+|neglect\w*|ignor\w*|treat\w* .{0,20} as)\b/i,
  },
  {
    group: "evidence",
    pattern:
      /\b(et al\.?|doi|arxiv|https?:\/\/|according to|reported|showed|shows that|demonstrat\w+|the (paper|study|authors|literature)|cite\w*|citation|known (result|fact)|theorem|lemma|proof|empirical|benchmark|dataset|experiment\w*)\b/i,
  },
  {
    group: "calculations",
    pattern:
      /(\d+(\.\d+)?\s*(%|percent|x|×|ms|s\b|seconds|minutes|hours|GB|MB|KB|tokens|samples|dimensions?|epochs?|steps?)|[=≈≠≤≥<>]\s*\d|\b(comput\w+|calculat\w+|estimat\w+|works out|yields|gives us|totals?|sum\w*|product|ratio|scal\w+ (as|with|like)|O\(|complexity)\b)/i,
  },
  {
    group: "conclusions",
    pattern:
      /\b(therefore|thus|hence|so (the|this|we|it)|implies|it follows|conclud\w+|this means|which (gives|means|shows)|consequently|as a result|in other words|the upshot|net effect)\b/i,
  },
];

/**
 * A decision is a sentence that weighs or picks between routes: an explicit
 * contrast (instead, rather than, versus, trade-off, the other approach), a
 * choice verb in the past or first person (I'll go with, decided, ruled
 * out, switched to), or an alternative named as such. Bare verbs that are
 * also everyday nouns (option, preference, drop) are deliberately absent.
 */
const DECISION_PATTERN =
  /\b(instead( of)?|rather than|alternativ(e|es|ely)|two options|the options|option [AB12]|either \w+ or\b|or else|trade-?offs?|(I|we)(?:'ll| will| should| could|'d| would|'m going to| decided to| chose to| opted to| prefer to| want to)? (?:\w+ ){0,2}(go with|stick with|switch to|pick|choose|opt for|settle on|rule out|drop|skip|abandon|revert to|fall back (?:on|to))\b|chose|decided|settled on|went with|opted|ruled out|rejected|abandoned|reverted|better to|simpler to|simplest (?:to|is)|not worth|versus|\bvs\.|the (first|second|third|other|simpler|safer|cheaper) (approach|route|path|way|option)|plan [AB]|fallback|compromise)\b/i;

/** A check the thinker meant to make, or could not make. */
const TO_CHECK_PATTERN =
  /\b(need(s|ed)? to (check|verify|confirm|double-check|test|make sure)|should (check|verify|confirm|double-check|test|make sure)|(I|we)(?:'ll| will| should| want to| have to| must) (?:\w+ ){0,2}(check|verify|confirm|double-check|test|make sure)|double-check|haven'?t (checked|verified|confirmed|tested)|can(?:'t|not) (verify|confirm|check|be sure)|could(?:n'?t| not) (verify|confirm|find|check)|unverified|unchecked|untested|not (yet )?(verified|confirmed|tested|proven|checked)|TODO|left for later|come back to (this|that|it)|without (checking|verifying)|take (this|that|it) on faith)\b/i;

/** A hedge: the thinker signalling it is not sure. */
const HEDGE_PATTERN =
  /\b(not sure|unsure|unclear|uncertain\w*|maybe|might|perhaps|possibly|probably|presumably|I (think|believe|suspect|guess|wonder|worry|hope|assume)|seems|appears|apparently|hard to (say|tell|verify|know)|open question|caveat|hand-?wav\w+|speculat\w+|if (this|that|it) holds|assuming (this|that|it)|questionable|doubt\w*|sketchy|shaky|fragile|rough(ly)? (estimate|guess)|ballpark|back-of-the-envelope)\b/i;

const GROUP_ORDER: readonly string[] = [
  "open question",
  "to-check",
  "hedge",
  "decision",
  "assumptions",
  "calculations",
  "evidence",
  "conclusions",
];

function tagged(
  index: NotesIndex,
  query: NotesQuery,
  mode: "claims" | "decisions" | "doubts",
): JsonObject {
  const filter =
    query.query !== undefined && query.query.trim() !== ""
      ? matcherFor(query.query, query.match ?? "any", query.caseSensitive === true)
      : undefined;
  const entries: JsonObject[] = [];
  const counts: Record<string, number> = {};
  for (const paragraph of inScope(index, query)) {
    paragraph.sentences.forEach((sentence, position) => {
      if (filter !== undefined && !filter(sentence)) return;
      let group: string | undefined;
      if (mode === "claims") {
        group = CLAIM_GROUPS.find((entry) => entry.pattern.test(sentence))?.group;
      } else if (mode === "decisions") {
        if (DECISION_PATTERN.test(sentence)) group = "decision";
      } else if (/\?\s*$/.test(sentence)) {
        group = "open question";
      } else if (TO_CHECK_PATTERN.test(sentence)) {
        group = "to-check";
      } else if (HEDGE_PATTERN.test(sentence)) {
        group = "hedge";
      }
      if (group === undefined) return;
      if (query.group !== undefined && group !== query.group) return;
      counts[group] = (counts[group] ?? 0) + 1;
      const following = paragraph.sentences[position + 1];
      entries.push({
        ...where(paragraph),
        id: `${paragraph.id}#${position + 1}`,
        group,
        text: sentence,
        ...(mode === "decisions" && following !== undefined ? { after: following } : {}),
      });
    });
  }
  // Stable order: the sharper groups first (open questions before hedges,
  // assumptions before evidence), then the notes' own order within a group.
  const rank = (entry: JsonObject): number => GROUP_ORDER.indexOf(entry.group as string);
  entries.sort((a, b) => rank(a) - rank(b));
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const picked = collect(entries, offset, bounded(query.maxResults, 30, MAX_RESULTS_CEILING), bounded(query.maxChars, 8_000, MAX_CHARS_CEILING));
  const guidance = hint(picked.more, picked.total, picked.results.length, offset, "sentences");
  return {
    mode,
    scope: scopeInfo(index),
    ...(query.query !== undefined ? { query: query.query } : {}),
    ...(query.group !== undefined ? { group: query.group } : {}),
    groups: counts,
    total: picked.total,
    results: picked.results,
    more: picked.more,
    ...(guidance !== undefined ? { hint: guidance } : {}),
    note:
      mode === "claims"
        ? "Sentences grouped by surface cues (assumption, evidence, calculation, conclusion words). The grouping is a lead for where to look, not a judgement."
        : mode === "decisions"
          ? "Sentences where the thinker weighed or chose between alternatives, each with the sentence that follows. Rejected alternatives are often where a flaw hides or a better route was passed over."
          : "Open questions first, then checks the thinker meant to make (to-check), then hedges. Every one is a lead to verify against the chain, never a finding.",
  };
}

/* ------------------------------------------------------------------------ */
/* overview                                                                 */
/* ------------------------------------------------------------------------ */

const STOPWORDS = new Set(
  "a an the and or but if then than so of to in on at by for with from as is are was were be been being it its this that these those i we you they he she them our their your my me us not no yes do does did done have has had having will would can could should may might must shall also just only very more most much many some any each other such about into over under again further here there when where why how all both few own same too s t can will don now let me i'm i'll i've it's that's there's what which who whom whose while after before during between through above below up down out off because until against".split(/\s+/),
);

function frequentTerms(paragraphs: readonly NoteParagraph[], count = 20): JsonObject[] {
  const tally = new Map<string, number>();
  for (const paragraph of paragraphs) {
    for (const raw of paragraph.text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []) {
      const word = raw.replace(/^'+|'+$/g, "");
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      tally.set(word, (tally.get(word) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([term, occurrences]) => ({ term, occurrences }));
}

function overview(index: NotesIndex): JsonObject {
  const perStep = new Map<string, { paragraphs: number; chars: number }>();
  for (const paragraph of index.paragraphs) {
    const key = paragraph.step !== undefined ? `step ${paragraph.step}` : "after the last step";
    const entry = perStep.get(key) ?? { paragraphs: 0, chars: 0 };
    entry.paragraphs += 1;
    entry.chars += paragraph.text.length;
    perStep.set(key, entry);
  }
  return {
    mode: "overview",
    scope: scopeInfo(index, true),
    traces: index.traces.map((trace) => ({
      source: trace.source,
      steps: trace.steps,
      ...(trace.rewrote !== undefined ? { rewrote: trace.rewrote } : {}),
      paragraphs: trace.paragraphs,
      characters: trace.visibleChars,
      ...(trace.hiddenChars > 0 ? { hiddenCharacters: trace.hiddenChars } : {}),
    })),
    byStep: Object.fromEntries(perStep),
    frequentTerms: frequentTerms(index.paragraphs),
    note:
      "A thinker usually does most of its thinking before submitting step 1, so the paragraphs written \"toward step 1\" cover the whole plan. Start with mode \"doubts\" or \"decisions\", or \"find\" with a term from the step you are reviewing, then \"read\" the paragraphs around a hit.",
  };
}

/** Runs one query over the index; throws NotesQueryError for a malformed query. */
export function searchNotes(index: NotesIndex, query: NotesQuery): JsonObject {
  if (index.paragraphs.length === 0) {
    return {
      mode: query.mode,
      scope: scopeInfo(index),
      results: [],
      total: 0,
      more: false,
      note:
        index.traces.length === 0
          ? "No working notes were recorded for this seat (the provider surfaced no thinking, or the run predates note capture). Review the chain text on its own."
          : `No notes are visible within steps 1..${index.scope.throughStep}.`,
    };
  }
  switch (query.mode) {
    case "find":
      return find(index, query);
    case "outline":
      return outline(index, query);
    case "read":
      return read(index, query);
    case "claims":
    case "decisions":
    case "doubts":
      return tagged(index, query, query.mode);
    case "overview":
      return overview(index);
    default:
      throw new NotesQueryError(`unknown mode "${String(query.mode)}"; use one of ${NOTES_MODES.join(", ")}.`);
  }
}

/** Parses the model's tool input into a NotesQuery; throws for malformed values. */
export function parseNotesInput(input: JsonValue): NotesQuery {
  const args = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as JsonObject) : {};
  const text = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const integer = (key: string): number | undefined => {
    const value = args[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
  };
  const choice = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      throw new NotesQueryError(`${key} must be one of ${allowed.join(", ")}.`);
    }
    return value as T;
  };
  const list = (key: string): string[] | undefined => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    const items = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return items.length > 0 ? items : undefined;
  };
  const stepsRaw = args.steps ?? args.step;
  const steps =
    stepsRaw === undefined || stepsRaw === null
      ? undefined
      : (Array.isArray(stepsRaw) ? stepsRaw : [stepsRaw]).flatMap((value) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? [value] : [],
        );
  const mode = choice("mode", NOTES_MODES) ?? "find";
  const query = text("query");
  const near = text("near");
  const context = integer("context");
  const offset = integer("offset");
  const maxResults = integer("max_results");
  const maxChars = integer("max_chars");
  const ids = list("ids");
  const from = text("from");
  const to = text("to");
  const match = choice("match", NOTES_MATCHES);
  const unit = choice("unit", NOTES_UNITS);
  const source = choice("source", NOTES_SOURCES);
  const group = text("group");
  return {
    mode,
    ...(query !== undefined ? { query } : {}),
    ...(match !== undefined ? { match } : {}),
    ...(args.case_sensitive === true ? { caseSensitive: true } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(near !== undefined ? { near } : {}),
    ...(steps !== undefined && steps.length > 0 ? { steps } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(ids !== undefined ? { ids } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(maxChars !== undefined ? { maxChars } : {}),
  };
}
