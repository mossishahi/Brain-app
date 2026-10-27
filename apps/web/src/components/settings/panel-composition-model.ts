/**
 * The settings drawer's Panel composition section as pure functions over
 * GET /api/panel-composition: parsing an edited value against the param's
 * declared type and range, and the override map a save sends — only the
 * values that differ from the bundle's defaults (contract K).
 *
 * No React and no DOM here, so `node --test` runs it.
 */

export type PanelParamValue = number | boolean | string;

export interface PanelParamView {
  readonly name: string;
  readonly group: string;
  readonly type: "int" | "number" | "bool" | "string";
  readonly default: PanelParamValue;
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
  readonly key?: "none" | "optional" | "required";
  readonly description: string;
  /** null: the registry could not be read, so the spec default is shown. */
  readonly declared: boolean | null;
  readonly effectiveDefault: PanelParamValue;
  readonly override?: PanelParamValue;
}

/** Response of GET /api/panel-composition. */
export interface PanelCompositionView {
  readonly bundle?: { readonly id: string; readonly version: string };
  readonly groups: readonly { readonly id: string; readonly title: string }[];
  readonly params: readonly PanelParamView[];
  readonly coreKeyConfigured: boolean;
}

/** One encoder's availability (GET /api/readiness/encoders). */
export interface EncoderReadinessView {
  readonly modelDir?: string;
  readonly selected: string;
  readonly selectedAvailable: boolean;
  readonly fallback: string;
  readonly encoders: readonly { readonly id: string; readonly available: boolean; readonly detail: string }[];
}

/** The value a run would use for a param. */
export function effectiveValue(param: PanelParamView): PanelParamValue {
  return param.override ?? param.effectiveDefault;
}

/**
 * Parses a typed value for a number or string param. Blank means "back to the
 * bundle default" (undefined); an invalid value yields an error message.
 */
export function parseParamInput(
  param: PanelParamView,
  raw: string,
): { readonly value?: PanelParamValue; readonly error?: string } {
  const text = raw.trim();
  if (text === "") return {};
  if (param.type === "string") {
    if (param.values && !param.values.includes(text)) {
      return { error: `${param.name} must be one of ${param.values.join(", ")}` };
    }
    if (
      param.name === "encoder" &&
      !["specter2", "bge-base-en-v1.5", "hash-ngram-v1"].includes(text) &&
      !/^openrouter:[^\s]+$/.test(text)
    ) {
      return { error: "encoder must be specter2, bge-base-en-v1.5, hash-ngram-v1 or openrouter:<model id>" };
    }
    return { value: text };
  }
  if (param.type === "bool") {
    if (text === "true") return { value: true };
    if (text === "false") return { value: false };
    return { error: `${param.name} must be true or false` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: `${param.name} must be a number` };
  if (param.type === "int" && !Number.isInteger(value)) {
    return { error: `${param.name} must be an integer` };
  }
  if (param.min !== undefined && value < param.min) {
    return { error: `${param.name} must be at least ${param.min}` };
  }
  if (param.max !== undefined && value > param.max) {
    return { error: `${param.name} must be at most ${param.max}` };
  }
  return { value };
}

/**
 * The overrides to save after setting one param (undefined = back to the
 * default): every param whose value differs from its bundle default, and
 * nothing else.
 */
export function nextOverrides(
  params: readonly PanelParamView[],
  name: string,
  value: PanelParamValue | undefined,
): Record<string, PanelParamValue> {
  const out: Record<string, PanelParamValue> = {};
  for (const param of params) {
    const candidate = param.name === name ? value : param.override;
    if (candidate !== undefined && candidate !== param.effectiveDefault) out[param.name] = candidate;
  }
  return out;
}
