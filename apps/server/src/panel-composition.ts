/**
 * Panel composition (spec v2, Section 0): every workflow param of the
 * paper-based panel composition, the per-run overrides the settings drawer
 * edits, their validation, the job-environment encoding the worker reads
 * (BRAINSTORM_AGENTIC_WORKFLOW_PARAMS, spec Section 12), and the defaults the
 * pinned bundle declares.
 *
 * The protocol package does not (yet) declare these settings fields, so the
 * server carries them as a structural extension of ServerSettings
 * (`panelComposition`); old clients never see or send them.
 */
import type { ServerSettings } from "@brainstorm-agentic/protocol";
import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";

export type PanelParamType = "int" | "number" | "bool" | "string";
export type PanelParamValue = number | boolean | string;
export type PanelParamGroup = "needs" | "sources" | "routes" | "evidence" | "selection";

export interface PanelParamSpec {
  readonly name: string;
  readonly group: PanelParamGroup;
  readonly type: PanelParamType;
  /** The spec's default; the pinned bundle's declaration wins where present. */
  readonly default: PanelParamValue;
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
  /** Sources only: whether the source needs an API key (spec 0.2). */
  readonly key?: "none" | "optional" | "required";
  readonly description: string;
}

export const PANEL_PARAM_GROUPS: readonly { readonly id: PanelParamGroup; readonly title: string }[] = [
  { id: "needs", title: "Needs and gates" },
  { id: "sources", title: "Sources" },
  { id: "routes", title: "Routes" },
  { id: "evidence", title: "Screen, placement, evidence" },
  { id: "selection", title: "Candidates, selection, size, flags" },
];

/** Spec v2 Section 0, transcribed table by table (names, types, defaults, ranges). */
export const PANEL_COMPOSITION_PARAMS: readonly PanelParamSpec[] = [
  { name: "panelSize", group: "needs", type: "int", default: 6, min: 2, max: 12, description: "k_max (existing)" },
  { name: "panelSizeMode", group: "needs", type: "string", default: "auto", values: ["auto", "fixed"], description: "auto = k*, fixed = k_max" },
  { name: "askUserToConfirmNeeds", group: "needs", type: "bool", default: false, description: "when true, a skippable gate shows the needs before retrieval (D2)" },
  { name: "coreWeight", group: "needs", type: "number", default: 1.0, min: 0, max: 1, description: "weight of need 0" },
  { name: "formulationWeight", group: "needs", type: "number", default: 0.5, min: 0, max: 1, description: "weight of the domain-free problem formulation as a need; 0 = used for retrieval only" },
  { name: "equivalentProblemWeight", group: "needs", type: "number", default: 0, min: 0, max: 1, description: "weight factor for each equivalent problem (times its confidence); 0 = retrieval only" },
  { name: "sourceArxiv", group: "sources", type: "bool", default: true, key: "none", description: "search" },
  { name: "sourceCrossref", group: "sources", type: "bool", default: true, key: "none", description: "search, DOI metadata" },
  { name: "sourceSemanticScholar", group: "sources", type: "bool", default: true, key: "optional", description: "search, statements, citations" },
  { name: "sourceOpenAlex", group: "sources", type: "bool", default: true, key: "required", description: "search, statements, citations" },
  { name: "sourceEuropePmc", group: "sources", type: "bool", default: false, key: "none", description: "search (life sciences)" },
  { name: "sourceCore", group: "sources", type: "bool", default: true, key: "required", description: "search (open-access full-text index)" },
  { name: "sourceOpenCitations", group: "sources", type: "bool", default: true, key: "optional", description: "citation hop only (DOI to DOI)" },
  { name: "resultsPerCall", group: "sources", type: "int", default: 25, min: 1, max: 100, description: "" },
  { name: "maxCalls", group: "sources", type: "int", default: 150, min: 10, max: 600, description: "hard budget of search + detail calls per run" },
  { name: "yearFrom", group: "sources", type: "int", default: 0, min: 0, max: 2100, description: "0 = no date window" },
  { name: "routeTitle", group: "routes", type: "bool", default: true, description: "q = T" },
  { name: "routeFacetNames", group: "routes", type: "bool", default: true, description: "q = facet name (as a quoted phrase where the source supports phrases)" },
  { name: "routeFacetAliases", group: "routes", type: "bool", default: true, description: "q = each alias of each facet (classifier v2)" },
  { name: "routePairs", group: "routes", type: "string", default: "all", values: ["off", "central", "all"], description: "off, central (v1 rule), all (every unordered facet pair) - route F" },
  { name: "maxPairQueries", group: "routes", type: "int", default: 15, description: "pairs kept, ranked by r_i * r_j" },
  { name: "routeStatements", group: "routes", type: "bool", default: true, description: "route B: long-text queries (facet statements, core abstract, formulation, equivalent-problem statements) to semantic-capable sources only (semantic-scholar, openalex, core)" },
  { name: "routeEquivalents", group: "routes", type: "bool", default: true, description: "q = each equivalent problem's name (keyword query, all sources)" },
  { name: "routeKnn", group: "routes", type: "bool", default: true, description: "route C" },
  { name: "knnK", group: "routes", type: "int", default: 5, min: 1, max: 50, description: "nearest topics per need in the topic-vector space" },
  { name: "knnHopK", group: "routes", type: "int", default: 0, min: 0, max: 20, description: "nearest topics of each topic found (second hop)" },
  { name: "knnKeywords", group: "routes", type: "int", default: 0, min: 0, max: 10, description: "upstream keywords per kNN topic issued as extra queries" },
  { name: "knnMaxQueries", group: "routes", type: "int", default: 20, description: "cap on route-C queries, ranked by best (similarity x need weight)" },
  { name: "routeCitations", group: "routes", type: "bool", default: true, description: "route D" },
  { name: "citationSeeds", group: "routes", type: "int", default: 10, description: "papers seeded per run (top evidence mass after round 1)" },
  { name: "citationLimit", group: "routes", type: "int", default: 25, description: "max references and max citations fetched per seed" },
  { name: "citationDirections", group: "routes", type: "string", default: "both", values: ["references", "citations", "both"], description: "references, citations, both" },
  { name: "routeFeedback", group: "routes", type: "bool", default: true, description: "route E" },
  { name: "feedbackSeeds", group: "routes", type: "int", default: 10, description: "top evidence papers per need used for term extraction" },
  { name: "feedbackTerms", group: "routes", type: "int", default: 5, description: "new terms per need; total capped at 20" },
  { name: "routeKeyTerms", group: "routes", type: "bool", default: false, description: "q = each verbatim key term of the submitter (classifier v2); off by default" },
  { name: "maxRounds", group: "routes", type: "int", default: 2, min: 1, max: 3, description: "" },
  { name: "minNewShare", group: "routes", type: "number", default: 0.1, description: "stop after a round that adds fewer than this share of new eligible papers" },
  { name: "relevanceScreen", group: "evidence", type: "bool", default: false, description: "one batched chat-model judgement per 40 papers (route \"balanced\"): on-topic yes/no + reason; off-topic papers are excluded from evidence and logged" },
  { name: "encoder", group: "evidence", type: "string", default: "specter2", description: "specter2, bge-base-en-v1.5, hash-ngram-v1, or openrouter:<model id> (needs key)" },
  { name: "minAbstractChars", group: "evidence", type: "int", default: 200, description: "" },
  { name: "maxPapers", group: "evidence", type: "int", default: 1000, description: "RRF cap" },
  { name: "topicsPerPaper", group: "evidence", type: "int", default: 3, description: "m" },
  { name: "papersPerNeed", group: "evidence", type: "int", default: 20, description: "K" },
  { name: "weakPlacementQuantile", group: "evidence", type: "number", default: 0.05, description: "" },
  { name: "minSupport", group: "selection", type: "int", default: 2, description: "" },
  { name: "saturationShare", group: "selection", type: "number", default: 0.3, description: "theta" },
  { name: "maxAffinity", group: "selection", type: "number", default: 0.8, description: "a_max" },
  { name: "seatsPerSubfield", group: "selection", type: "int", default: 0, description: "0 = no subfield cap (v1 had 2; the test showed it starves large subfields)" },
  { name: "seatsPerField", group: "selection", type: "int", default: 0, description: "0 = ceil(panelSize/2)" },
  { name: "gainStop", group: "selection", type: "number", default: 0.05, description: "epsilon" },
  { name: "criticalWeight", group: "selection", type: "number", default: 0.5, description: "" },
  { name: "criticalCoverage", group: "selection", type: "number", default: 0.75, description: "k_cov target (v1 had 0.8, unreachable with a_max 0.8)" },
  { name: "anchors", group: "selection", type: "bool", default: true, description: "facet-anchored candidates" },
  { name: "anchorThreshold", group: "selection", type: "number", default: 0.4, description: "" },
  { name: "anchorAffinity", group: "selection", type: "number", default: 0.6, description: "" },
  { name: "rescueUncoveredNeeds", group: "selection", type: "bool", default: true, description: "after selection, a critical need still below anchorThreshold coverage gets its anchored seat if capacity remains, caps notwithstanding" },
  { name: "shareAlarm", group: "selection", type: "number", default: 0.6, description: "" },
  { name: "thinNeed", group: "selection", type: "number", default: 0.25, description: "" },
  { name: "hubShare", group: "selection", type: "number", default: 0.5, description: "" },
];

const PARAM_BY_NAME: ReadonlyMap<string, PanelParamSpec> = new Map(
  PANEL_COMPOSITION_PARAMS.map((spec) => [spec.name, spec]),
);

export function panelParamSpec(name: string): PanelParamSpec | undefined {
  return PARAM_BY_NAME.get(name);
}

/** The encoders spec Section 9 names; `openrouter:<model id>` needs the OpenRouter key. */
export const LOCAL_ENCODER_IDS = ["specter2", "bge-base-en-v1.5"] as const;
export const BUILTIN_ENCODER_ID = "hash-ngram-v1";

export function validEncoderId(value: string): boolean {
  return (
    (LOCAL_ENCODER_IDS as readonly string[]).includes(value) ||
    value === BUILTIN_ENCODER_ID ||
    /^openrouter:[^\s]+$/.test(value)
  );
}

/** The stored section: only values that differ from the bundle's defaults. */
export interface PanelCompositionSettings {
  readonly params: Readonly<Record<string, PanelParamValue>>;
}

/** ServerSettings as this server carries it (structural extension). */
export type WithPanelComposition<T> = T & {
  readonly panelComposition?: PanelCompositionSettings;
};

/** The section of a settings document, when it holds at least one override. */
export function panelCompositionOf(settings: ServerSettings): PanelCompositionSettings | undefined {
  const section = (settings as WithPanelComposition<ServerSettings>).panelComposition;
  if (section === undefined || typeof section !== "object" || section === null) return undefined;
  const params = (section as { params?: unknown }).params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  return Object.keys(params).length > 0 ? (section as PanelCompositionSettings) : undefined;
}

/** One override, checked against the spec's type, values and range. */
export function validatePanelParam(name: string, value: unknown): PanelParamValue {
  const spec = PARAM_BY_NAME.get(name);
  const label = `panelComposition.params.${name}`;
  if (!spec) throw new Error(`${label} is not a panel composition param`);
  switch (spec.type) {
    case "bool":
      if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
      return value;
    case "string": {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${label} must be a non-empty string`);
      }
      if (spec.values && !spec.values.includes(value)) {
        throw new Error(`${label} must be one of ${spec.values.join(", ")}`);
      }
      if (name === "encoder" && !validEncoderId(value)) {
        throw new Error(
          `${label} must be specter2, bge-base-en-v1.5, hash-ngram-v1 or openrouter:<model id>`,
        );
      }
      return value;
    }
    case "int":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a number`);
      }
      if (spec.type === "int" && !Number.isInteger(value)) {
        throw new Error(`${label} must be an integer`);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new Error(`${label} must be at least ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new Error(`${label} must be at most ${spec.max}`);
      }
      return value;
    }
  }
}

/**
 * The section as submitted or stored: `{}` and `{params: {}}` mean "follow
 * the bundle's defaults" (no overrides). Unknown params are refused.
 */
export function validatePanelComposition(value: unknown): PanelCompositionSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("panelComposition must be an object");
  }
  const raw = (value as { params?: unknown }).params;
  if (raw === undefined) return { params: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("panelComposition.params must be an object");
  }
  const params: Record<string, PanelParamValue> = {};
  for (const name of Object.keys(raw).sort()) {
    params[name] = validatePanelParam(name, (raw as Record<string, unknown>)[name]);
  }
  return { params };
}

/**
 * BRAINSTORM_AGENTIC_WORKFLOW_PARAMS for a run (spec Section 12): one JSON
 * object, keys sorted, absent when the run overrides nothing. The worker drops
 * unknown composition keys; requested game policy must be supported explicitly.
 */
export function workflowParamsJson(settings: ServerSettings): string | undefined {
  const section = panelCompositionOf(settings);
  const params: Record<string, PanelParamValue> = { ...(section?.params ?? {}) };
  // An absent/off flag preserves compatibility with older bundles. ON must
  // reach the worker, which rejects bundles that do not declare this mode.
  if (settings.gamifiedReview === true) {
    params.gamifiedReview = true;
    params.gameDecisionThreshold = settings.gameReview?.threshold ?? 0.5;
    params.gameInitialPoints = settings.gameReview?.initialPoints ?? -1;
    params.gameDecisionRule = settings.gameReview?.decisionRule ?? "chair-decisive";
    params.gameLeaveOneOut = settings.gameReview?.leaveOneOut ?? true;
  }
  const sorted: Record<string, PanelParamValue> = {};
  for (const name of Object.keys(params).sort()) sorted[name] = params[name]!;
  return Object.keys(sorted).length > 0 ? JSON.stringify(sorted) : undefined;
}

/** One workflow param as the pinned bundle declares it. */
export interface DeclaredWorkflowParam {
  readonly default: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly description?: string;
}

export interface DeclaredWorkflowParams {
  readonly bundle: string;
  readonly version: string;
  readonly params: Readonly<Record<string, DeclaredWorkflowParam>>;
}

const CACHE_TTL_MS = 5 * 60_000;

/**
 * The pinned bundle's workflow.params, read from the Brain Registry and
 * cached like the route catalog. Undefined when the registry cannot be read
 * and nothing is cached: the drawer then shows the spec defaults, marked as
 * such.
 */
export class WorkflowParamsCatalog {
  readonly #cache = new Map<string, { readonly at: number; readonly value: DeclaredWorkflowParams }>();

  async declared(
    registryUrl: string,
    bundle: string,
    version?: string,
  ): Promise<DeclaredWorkflowParams | undefined> {
    const key = `${registryUrl}\u0000${bundle}\u0000${version ?? ""}`;
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    try {
      const client = new ContentRegistryClient(registryUrl);
      try {
        const pin = await client.resolvePin(bundle, version);
        const root = `bundles/${bundle}/${pin.version}`;
        const manifest = JSON.parse(await client.readText(`${root}/bundle.json`)) as {
          readonly entrypoints?: { readonly workflow?: unknown };
        };
        const workflowPath =
          typeof manifest.entrypoints?.workflow === "string"
            ? manifest.entrypoints.workflow
            : "workflows/brainstorm.workflow.json";
        const workflow = JSON.parse(await client.readText(`${root}/${workflowPath}`)) as {
          readonly params?: unknown;
        };
        const value: DeclaredWorkflowParams = {
          bundle,
          version: pin.version,
          params: declaredParams(workflow.params),
        };
        this.#cache.set(key, { at: Date.now(), value });
        return value;
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch {
      return hit?.value;
    }
  }
}

/** Keeps only well-formed declarations (`default` present, numeric bounds). */
export function declaredParams(raw: unknown): Record<string, DeclaredWorkflowParam> {
  const out: Record<string, DeclaredWorkflowParam> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [name, definition] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) continue;
    const entry = definition as Record<string, unknown>;
    if (!("default" in entry)) continue;
    out[name] = {
      default: entry.default,
      ...(typeof entry.min === "number" ? { min: entry.min } : {}),
      ...(typeof entry.max === "number" ? { max: entry.max } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    };
  }
  return out;
}

/** One row of the drawer's Panel composition section. */
export interface PanelParamView extends PanelParamSpec {
  /** Whether the pinned bundle declares this param (undeclared overrides are dropped by the worker). */
  readonly declared: boolean | null;
  /** The default the run would use: the bundle's when declared, else the spec's. */
  readonly effectiveDefault: PanelParamValue;
  /** The stored override, when one is set. */
  readonly override?: PanelParamValue;
}

/** Response of GET /api/panel-composition. */
export interface PanelCompositionView {
  readonly bundle?: { readonly id: string; readonly version: string };
  readonly groups: typeof PANEL_PARAM_GROUPS;
  readonly params: readonly PanelParamView[];
  readonly coreKeyConfigured: boolean;
}

export function panelCompositionView(
  settings: ServerSettings,
  declared: DeclaredWorkflowParams | undefined,
  coreKeyConfigured: boolean,
): PanelCompositionView {
  const overrides = panelCompositionOf(settings)?.params ?? {};
  return {
    ...(declared ? { bundle: { id: declared.bundle, version: declared.version } } : {}),
    groups: PANEL_PARAM_GROUPS,
    params: PANEL_COMPOSITION_PARAMS.map((spec): PanelParamView => {
      const declaration = declared?.params[spec.name];
      const bundleDefault = declaration?.default;
      const effectiveDefault =
        bundleDefault !== undefined &&
        (typeof bundleDefault === "number" ||
          typeof bundleDefault === "boolean" ||
          typeof bundleDefault === "string")
          ? bundleDefault
          : spec.default;
      return {
        ...spec,
        ...(declaration?.min !== undefined ? { min: declaration.min } : {}),
        ...(declaration?.max !== undefined ? { max: declaration.max } : {}),
        declared: declared === undefined ? null : declaration !== undefined,
        effectiveDefault,
        ...(overrides[spec.name] !== undefined ? { override: overrides[spec.name]! } : {}),
      };
    }),
    coreKeyConfigured,
  };
}
