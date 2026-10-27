/**
 * The run's thinker notes, read back from the thinking artifacts the
 * ThinkingArtifactAgentExecutor writes (see wiring.ts): one artifact per
 * chain-writing task, holding the FULL recorded trace and the turn each step
 * was submitted in. A seat's notes are every such artifact its first pass
 * and its redevelopments left, in the order they were written.
 *
 * Artifacts written before the metadata carried `agentId` and `schema`
 * cannot be attributed to a seat, so a run resumed across this change simply
 * has no notes to search for its earlier tasks; nothing is guessed.
 */
import type { ArtifactRef, ArtifactStore, JsonValue, NoteTrace, NotesAccess, NotesScope } from "@brainstorm-agentic/core";

/** The output schemas of a seat's first pass and of its repairs. */
export const FIRST_PASS_SCHEMAS: ReadonlySet<string> = new Set(["brainIdea", "brainIdeaParts"]);
export const REDEVELOPMENT_SCHEMAS: ReadonlySet<string> = new Set([
  "redevelopment",
  "redevelopmentPatch",
  "redevelopmentPatchParts",
]);

function artifactNumber(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function metadataString(ref: ArtifactRef, key: string): string | undefined {
  const value = ref.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function segmentsOf(value: JsonValue | undefined): NoteTrace["segments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const { turn, text } = entry as { turn?: unknown; text?: unknown };
    return typeof turn === "number" && typeof text === "string" && text.length > 0 ? [{ turn, text }] : [];
  });
}

function stepTurnsOf(value: JsonValue | undefined): NoteTrace["stepTurns"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const { index, turn } = entry as { index?: unknown; turn?: unknown };
    return typeof index === "number" && typeof turn === "number" ? [{ index, turn }] : [];
  });
}

export class ArtifactNotesAccess implements NotesAccess {
  /** The store is the run's own (one artifact directory per run). */
  constructor(private readonly artifacts: ArtifactStore) {}

  async traces(scope: NotesScope): Promise<readonly NoteTrace[]> {
    const refs = (await this.artifacts.list())
      .filter(
        (ref) =>
          metadataString(ref, "kind") === "thinking" &&
          metadataString(ref, "agentId") === scope.seat,
      )
      .filter((ref) => {
        const schema = metadataString(ref, "schema") ?? "";
        return FIRST_PASS_SCHEMAS.has(schema) || REDEVELOPMENT_SCHEMAS.has(schema);
      })
      .sort((a, b) => artifactNumber(a.id) - artifactNumber(b.id));
    // A retried task writes its trace again under the same name; only the
    // latest write counts, so ids stay unique and nothing is read twice.
    const latestByName = new Map<string, ArtifactRef>();
    for (const ref of refs) latestByName.set(ref.name, ref);
    const traces: NoteTrace[] = [];
    let repairs = 0;
    for (const ref of refs.filter((candidate) => latestByName.get(candidate.name) === candidate)) {
      const stored = await this.artifacts.get(ref.id);
      if (stored === undefined) continue;
      let parsed: { segments?: JsonValue; stepTurns?: JsonValue };
      try {
        parsed = JSON.parse(stored.data) as { segments?: JsonValue; stepTurns?: JsonValue };
      } catch {
        continue; // an unreadable trace is simply not searchable
      }
      const stepTurns = stepTurnsOf(parsed.stepTurns);
      const firstPass = FIRST_PASS_SCHEMAS.has(metadataString(ref, "schema") ?? "");
      if (!firstPass) repairs += 1;
      traces.push({
        kind: firstPass ? "first-pass" : "redevelopment",
        order: firstPass ? 0 : repairs,
        segments: segmentsOf(parsed.segments),
        stepTurns,
        ...(firstPass ? {} : { rewrote: [...new Set(stepTurns.map((step) => step.index))].sort((a, b) => a - b) }),
      });
    }
    return traces;
  }
}
