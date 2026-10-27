/**
 * Per-run workflow-param overrides from the server's settings snapshot (the
 * environment is the submission channel; spec v2, Section 12).
 *
 * - BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: a JSON object of overrides. A key the
 *   pinned workflow does not declare is dropped with a log line, as is a
 *   value whose type differs from the declared default's, or a number
 *   outside the declared min/max.
 * - gamifiedReview is an explicit strategy selection: an invalid value or
 *   requesting it from a bundle that does not support it is an error. It
 *   must never silently turn an intended game run into a standard run.
 * - gameDecisionThreshold and gameInitialPoints are equally strict: silently
 *   dropping these would change the requested decisions or retirement rule.
 *   The initial-points value -1 is the host's automatic panel-size default.
 * - gameDecisionRule and gameLeaveOneOut follow the gamifiedReview pattern: a
 *   bundle that does not declare them accepts only the legacy values
 *   ("committee-mean", false) and rejects any other value explicitly.
 * - BRAINSTORM_AGENTIC_MAX_REVIEW_ROUNDS and BRAINSTORM_AGENTIC_PANEL_SIZE
 *   keep working and win over the JSON for their two params.
 *
 * Read only by `run`: a resume replays the params its checkpoint recorded at
 * start, so the variables are ignored there. The pinned bundle's declared
 * bounds still validate every value authoritatively when the run starts; an
 * unparsable value is ignored with a loud line rather than guessed at.
 */

/** A declared workflow param (the parts this reader checks). */
export interface DeclaredWorkflowParam {
  readonly default: string | number | boolean;
  readonly min?: number;
  readonly max?: number;
}

export type WorkflowParamValue = string | number | boolean;

export function workflowParamsFromEnv(
  env: NodeJS.ProcessEnv,
  declared: Readonly<Record<string, DeclaredWorkflowParam>> = {},
  log: (line: string) => void = (line) => console.error(line),
): Record<string, WorkflowParamValue> | undefined {
  const params: Record<string, WorkflowParamValue> = {};
  const json = env.BRAINSTORM_AGENTIC_WORKFLOW_PARAMS?.trim();
  if (json !== undefined && json !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      log(
        `[config] ignoring BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: not JSON (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      parsed = undefined;
    }
    if (parsed !== undefined && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
      log("[config] ignoring BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: not a JSON object");
    } else if (parsed !== undefined) {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        const definition = Object.prototype.hasOwnProperty.call(declared, name) ? declared[name] : undefined;
        if (name === "gamifiedReview") {
          if (typeof value !== "boolean") {
            throw new Error("gamifiedReview must be a boolean (true or false)");
          }
          if (definition === undefined && value === false) continue;
          if (definition === undefined || typeof definition.default !== "boolean") {
            throw new Error(
              "Gamified review is not supported by the pinned Brain bundle. " +
              "Select a bundle with gamified review support, or turn Gamified review off for a new run.",
            );
          }
        }
        if (name === "gameDecisionThreshold" || name === "gameInitialPoints") {
          const valid = typeof value === "number" && Number.isFinite(value) &&
            (name === "gameDecisionThreshold" ? value >= 0 && value <= 1 : value === -1 || value >= 0);
          if (!valid) {
            throw new Error(name === "gameDecisionThreshold"
              ? "gameDecisionThreshold must be a finite probability from 0 through 1"
              : "gameInitialPoints must be a finite nonnegative number, or -1 for the automatic panel-size default");
          }
          if (definition === undefined || typeof definition.default !== "number") {
            throw new Error(
              `The pinned Brain bundle does not support ${name}. ` +
              "Select a bundle with the committee chair decision and balance rules before starting this game run.",
            );
          }
          if ((definition.min !== undefined && value < definition.min) ||
              (definition.max !== undefined && value > definition.max)) {
            throw new Error(`${name} is outside the bounds declared by the pinned Brain bundle`);
          }
        }
        if (name === "gameDecisionRule") {
          if (value !== "committee-mean" && value !== "chair-decisive") {
            throw new Error("gameDecisionRule must be \"committee-mean\" or \"chair-decisive\"");
          }
          if (definition === undefined && value === "committee-mean") continue;
          if (definition === undefined || typeof definition.default !== "string") {
            throw new Error(
              "The pinned Brain bundle does not support gameDecisionRule. " +
              "Select a bundle with the committee chair decisiveness label, or choose the committee-mean rule for a new run.",
            );
          }
        }
        if (name === "gameLeaveOneOut") {
          if (typeof value !== "boolean") {
            throw new Error("gameLeaveOneOut must be a boolean (true or false)");
          }
          if (definition === undefined && value === false) continue;
          if (definition === undefined || typeof definition.default !== "boolean") {
            throw new Error(
              "The pinned Brain bundle does not support gameLeaveOneOut. " +
              "Select a bundle with leave-one-out scoring, or turn Leave-one-out scoring off for a new run.",
            );
          }
        }
        if (definition === undefined) {
          log(`[config] dropping workflow param "${name}": the pinned workflow does not declare it`);
          continue;
        }
        if (typeof value !== typeof definition.default) {
          log(
            `[config] dropping workflow param "${name}": expected a ${typeof definition.default}, got ${
              value === null ? "null" : Array.isArray(value) ? "array" : typeof value
            }`,
          );
          continue;
        }
        if (typeof value === "number") {
          if (!Number.isFinite(value)) {
            log(`[config] dropping workflow param "${name}": not a finite number`);
            continue;
          }
          if (definition.min !== undefined && value < definition.min) {
            log(`[config] dropping workflow param "${name}"=${value}: below its minimum ${definition.min}`);
            continue;
          }
          if (definition.max !== undefined && value > definition.max) {
            log(`[config] dropping workflow param "${name}"=${value}: above its maximum ${definition.max}`);
            continue;
          }
        }
        params[name] = value as WorkflowParamValue;
      }
    }
  }
  const read = (name: string, param: string): void => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      log(`[config] ignoring invalid ${name}="${raw}"`);
      return;
    }
    params[param] = value;
  };
  read("BRAINSTORM_AGENTIC_MAX_REVIEW_ROUNDS", "maxReviewRounds");
  read("BRAINSTORM_AGENTIC_PANEL_SIZE", "panelSize");
  return Object.keys(params).length > 0 ? params : undefined;
}
