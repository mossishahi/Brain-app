/**
 * Per-step thought slices, cut from a task's captured native-thinking trace.
 *
 * Executors record two facts side by side in a result's metadata: the
 * thinking segments the provider streamed (one entry per turn, in order) and
 * the turn each `submit_step` call happened in. The model's own submissions
 * are therefore the chunk boundaries — no heuristic splitter exists or is
 * needed: the thoughts "behind" step k are the segments recorded after the
 * previous submitted step's turn, up to and including step k's own turn.
 *
 * Two properties matter to every consumer:
 *
 * - The slices are computed ONCE, by the worker, from a single attempt's
 *   capture (executors build the capture fresh per attempt, so a validation
 *   retry can never interleave two sessions' turn counters), and ride the
 *   journaled result — so a resumed run rebuilds byte-identical state from
 *   the journal alone, exactly like every other output.
 * - A slice can legitimately be EMPTY: providers summarize or withhold
 *   thinking (display "omitted", offline runs, models without a reasoning
 *   channel), and several steps submitted in one turn share that turn's
 *   segments. Readers must treat "" as "nothing was recorded", never as an
 *   error.
 */
import type { JsonValue } from "@brainstorm-agentic/core";

export interface ThoughtSlice {
  /** 1-based chain step the slice belongs to. */
  readonly step: number;
  /** The recorded thinking behind that step; "" when nothing was recorded. */
  readonly text: string;
}

interface ThinkingSegment {
  readonly turn: number;
  readonly text: string;
}

interface StepTurn {
  readonly index: number;
  readonly turn: number;
}

/**
 * Ceiling for one step's journaled slice. The journal must stay bounded by
 * the run's real outputs; summarized thinking is normally a few KB per turn,
 * so this only guards against a pathological trace. The FULL trace keeps
 * living in the task's .thinking.json artifact, untruncated.
 */
export const MAX_THOUGHT_SLICE_CHARS = 20_000;

const TRUNCATION_MARK = "\n… [thoughts truncated]";

function segmentsFrom(value: JsonValue | undefined): readonly ThinkingSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const { turn, text } = entry as { turn?: unknown; text?: unknown };
    return typeof turn === "number" && typeof text === "string" && text.length > 0
      ? [{ turn, text }]
      : [];
  });
}

function stepTurnsFrom(value: JsonValue | undefined): readonly StepTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const { index, turn } = entry as { index?: unknown; turn?: unknown };
    return typeof index === "number" && typeof turn === "number"
      ? [{ index, turn }]
      : [];
  });
}

function capped(text: string): string {
  if (text.length <= MAX_THOUGHT_SLICE_CHARS) return text;
  return text.slice(0, MAX_THOUGHT_SLICE_CHARS) + TRUNCATION_MARK;
}

/**
 * Cuts a task's thinking trace into per-submitted-step slices.
 *
 * Steps are walked in submission order (turn, then index — ascending index is
 * what the skills mandate, so the two agree in practice). Step k's slice is
 * every segment with turn in (turn of the previous submitted step, turn of
 * step k]. Steps submitted in the SAME turn share that turn's segments —
 * attributing a shared turn any more finely would be invention. Segments
 * after the last submitted step (the writing of the result body) belong to
 * no step and stay in the artifact only.
 *
 * Returns one entry per submitted step, in ascending step order. Empty when
 * the task recorded no thinking or submitted no steps.
 */
export function sliceThoughtsBySteps(
  thinkingSegments: JsonValue | undefined,
  stepTurns: JsonValue | undefined,
): readonly ThoughtSlice[] {
  const segments = segmentsFrom(thinkingSegments);
  const steps = [...stepTurnsFrom(stepTurns)].sort(
    (a, b) => a.turn - b.turn || a.index - b.index,
  );
  if (steps.length === 0) return [];

  const slices: ThoughtSlice[] = [];
  let previousTurn = 0;
  for (const step of steps) {
    let text = segments
      .filter((segment) => segment.turn > previousTurn && segment.turn <= step.turn)
      .map((segment) => segment.text)
      .join("\n\n");
    if (text.length === 0 && step.turn === previousTurn) {
      // Same-turn siblings share the turn's segments rather than reading as
      // "thought about nothing".
      text = segments
        .filter((segment) => segment.turn === step.turn)
        .map((segment) => segment.text)
        .join("\n\n");
    }
    slices.push({ step: step.index, text: capped(text) });
    previousTurn = Math.max(previousTurn, step.turn);
  }
  return slices.sort((a, b) => a.step - b.step);
}
