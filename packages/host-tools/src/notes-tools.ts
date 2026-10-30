/**
 * The `notes_search` host tool: a reviewer's window into the thinker's
 * working notes, satisfying the `notes-access` capability.
 *
 * The notes are the recorded thinking behind the chain under review — the
 * seat's first pass and every repair since — read in full and searched in
 * place of being pasted into the prompt (where they used to arrive cut at
 * 20,000 characters per step). The tool is scoped per task: it answers
 * only about the seat under review and only with thinking recorded up to
 * the chain position the reviewer has been shown. The scope comes from the
 * task (metadata.notesScope, stamped by the workflow runtime); a task
 * without one gets a refusal, never another seat's notes.
 */
import type {
  HostToolManifest,
  JsonValue,
  NotesAccess,
  NotesScope,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@brainstorm-agentic/core";

import { buildNotesIndex } from "./notes/index-notes.js";
import {
  NOTES_MATCHES,
  NOTES_MODES,
  NOTES_SOURCES,
  NOTES_UNITS,
  NotesQueryError,
  parseNotesInput,
  searchNotes,
} from "./notes/search.js";

const lines = (...text: readonly string[]): string => text.join("\n");

export const NOTES_SEARCH_DEFINITION = {
  name: "notes_search",
  description: lines(
    "Search optional working notes: thinking summaries the provider exposed during the first pass and subsequent repairs. They may be partial or entirely absent. The notes never appear in your prompt; this tool shows only notes recorded up to the step you have been shown. Check overview once; when no notes are available, stop searching notes and review the submitted argument and independently verified evidence alone. Missing notes are not a flaw and must not change a verdict or trigger a retry. Never request or reconstruct a private transcript.",
    "Why it helps you: the chain text is the polished result; the notes show how it was reached — the assumptions the thinker made and did not state, the alternatives it weighed and dropped, the numbers it worked out, the sources it relied on, and the places it was unsure or meant to check and never did. Those are leads for your suspicions. A lead is never a finding: verify every lead against the chain text and your own evidence before it enters a comment.",
    "Modes:",
    "- \"overview\": availability, size per source and per step, the most frequent terms, and where to start. Call it once first; an empty answer ends notes exploration.",
    "- \"doubts\": sentences where the thinker left a question open (group \"open question\"), meant to check something (\"to-check\": need to verify, haven't tested, can't confirm) or hedged (\"hedge\"), in that order.",
    "- \"decisions\": sentences where the thinker chose between alternatives (each with the sentence that follows), e.g. a method it rejected.",
    "- \"claims\": sentences grouped as assumptions, calculations (numbers, estimates), evidence (citations, papers, URLs) and conclusions, in that order. Add query to keep only sentences about a topic, or group to keep one group.",
    "- \"find\" (default): sentences containing your query. match \"all\" (default: every word must occur; words match inside longer words, so batch also finds batches), \"any\", \"phrase\" (exact wording) or \"regex\". unit \"sentence\" (default), \"paragraph\" (the whole paragraph around each hit) or \"window\" (the hit with `context` sentences on each side). near: a second term that must occur in the same paragraph.",
    "- \"outline\": one line per paragraph with its id, source and step, for orientation.",
    "- \"read\": the full text of paragraphs by id (\"F:14\"), of a sentence (\"F:14#2\"), or of a range (from \"F:12\" to \"F:16\").",
    "Filters for every mode: steps (only paragraphs written toward these chain steps — note that most thinking is usually recorded before step 1 is submitted, so it sits under step 1), source (\"first-pass\", \"redevelopments\" or \"all\"). Answers are bounded by max_results and max_chars and carry ids; when `more` is true, continue with offset or narrow the query.",
    "Example: {\"mode\": \"doubts\"} then {\"mode\": \"find\", \"query\": \"convergence\", \"unit\": \"window\", \"context\": 2} then {\"mode\": \"read\", \"from\": \"F:30\", \"to\": \"F:33\"}.",
    "Confidential to the board: the thinker does not know these notes are read, so never quote, paraphrase, cite or hint at them in any output field. Your marks stand on the chain text and your own verified evidence.",
  ),
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: [...NOTES_MODES],
        default: "find",
        description: "What to do: overview, doubts, decisions, claims, find, outline or read (see the tool description).",
      },
      query: {
        type: "string",
        description:
          "For find: the words to look for (\"quoted words\" stay together). For claims, decisions and doubts: optional, keeps only sentences containing these words (any of them).",
      },
      match: {
        type: "string",
        enum: [...NOTES_MATCHES],
        default: "all",
        description: "How query is matched: all words (each as a substring), any word, the exact phrase, or a regular expression.",
      },
      case_sensitive: { type: "boolean", default: false, description: "Match letter case exactly." },
      unit: {
        type: "string",
        enum: [...NOTES_UNITS],
        default: "sentence",
        description: "For find: return the matching sentence, its whole paragraph, or a window of sentences around it.",
      },
      context: {
        type: "integer",
        minimum: 0,
        maximum: 5,
        default: 1,
        description: "For unit \"window\": sentences shown before and after each hit.",
      },
      near: {
        type: "string",
        description: "For find: a second term (any of its words) that must occur in the same paragraph as the hit.",
      },
      steps: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        maxItems: 20,
        description: "Only notes written toward these chain steps (1-based). Omit for all steps you have been shown.",
      },
      source: {
        type: "string",
        enum: [...NOTES_SOURCES],
        default: "all",
        description: "Only the first pass, only the repairs since, or both.",
      },
      group: {
        type: "string",
        description:
          "For claims, decisions and doubts: keep only one group (claims: assumptions, calculations, evidence, conclusions; doubts: open question, to-check, hedge).",
      },
      ids: {
        type: "array",
        items: { type: "string" },
        maxItems: 40,
        description: "For read: paragraph ids such as \"F:14\" or \"R1:3\", or sentence ids such as \"F:14#2\".",
      },
      from: { type: "string", description: "For read: first paragraph id of a range (same trace as `to`)." },
      to: { type: "string", description: "For read: last paragraph id of a range." },
      offset: { type: "integer", minimum: 0, description: "Skip this many results (continue a cut list)." },
      max_results: { type: "integer", minimum: 1, maximum: 100, description: "Result ceiling (defaults differ per mode; 20 for find)." },
      max_chars: {
        type: "integer",
        minimum: 500,
        maximum: 24000,
        description: "Character budget for the results (defaults differ per mode; 6000 for find).",
      },
    },
    additionalProperties: false,
  },
} as const;

export const NOTES_SEARCH_MANIFEST: HostToolManifest = {
  toolId: "notes_search",
  displayName: "Thinker Notes Search",
  operations: ["notes.search"],
  risk: "low",
  defaultEnabled: true,
  definition: NOTES_SEARCH_DEFINITION,
};

export const NOTES_MANIFESTS: readonly HostToolManifest[] = [NOTES_SEARCH_MANIFEST];
export const NOTES_TOOL_NAMES = ["notes_search"] as const;

/** Resolves the caller's scope: fixed for a per-task bridge, looked up per call otherwise. */
export type NotesScopeResolver = NotesScope | ((context: ToolExecutionContext) => NotesScope | undefined);

function refusal(message: string): ToolResult {
  return { output: message, isError: true };
}

/**
 * Runs one notes query for a task. The scope decides what is readable; the
 * traces are fetched per call (they are small files, and a repair that
 * landed between two calls of one task must be visible to the next call).
 */
export async function runNotesSearch(
  notes: NotesAccess,
  scope: NotesScope,
  input: JsonValue,
  signal?: AbortSignal,
): Promise<ToolResult> {
  let query;
  try {
    query = parseNotesInput(input);
  } catch (error) {
    if (error instanceof NotesQueryError) return refusal(error.message);
    throw error;
  }
  const traces = await notes.traces(scope, signal);
  const index = buildNotesIndex(traces, scope);
  try {
    return { output: searchNotes(index, query) };
  } catch (error) {
    if (error instanceof NotesQueryError) return refusal(error.message);
    throw error;
  }
}

/** The notes_search tool over a NotesAccess, scoped by `scopeOf`. */
export function notesTools(notes: NotesAccess, scopeOf: NotesScopeResolver): readonly Tool[] {
  const tool: Tool = {
    definition: NOTES_SEARCH_DEFINITION,
    async execute(input, context) {
      const scope = typeof scopeOf === "function" ? scopeOf(context) : scopeOf;
      if (scope === undefined) {
        return refusal("No thinker notes are in scope for this task: the tool answers only inside a chain review.");
      }
      return runNotesSearch(notes, scope, input, context.signal);
    },
  };
  return [tool];
}
