/**
 * Tool availability: one probe per provider/tool, the derived per-purpose
 * order, and the persisted table the worker seeds its web manager from
 * (spec 2026-10-03 "availability.md"; contract Section D).
 *
 * The service probes every tool the pipeline may use — the web sources and
 * SearXNG engines, the chat model, OpenRouter embeddings, the local text
 * encoders, the Brain Registry, the app-launched SearXNG, the code workspace
 * and the SLURM scheduler — and records, per tool, a state, a latency, a
 * one-line detail and the log lines produced while probing (secrets
 * redacted). From the configured route lists it derives the effective order
 * per purpose with host-tools' deriveEffectiveOrder (disabled / needs-key /
 * unreachable / blocked dropped, degraded moved behind every available tool)
 * and persists everything atomically in this server's instance directory.
 * Standalone consumers without a server identity use <workspace>/availability.json.
 *
 * Triggers (spec Section 3) are wired by the server: start, settings saves
 * (only the affected tools — see affectedTools), the probe endpoint, the
 * periodic timer and the cooldown re-probe of unreachable/blocked tools.
 */
import { join } from "node:path";
import process from "node:process";

import type { WebSourceStatus } from "@brainstorm-agentic/core";
import {
  DEFAULT_ENGINE_CANARIES,
  EnginePool,
  deriveEffectiveOrder,
  LOCAL_SEARXNG_ENGINES,
  arxivBackend,
  braveProvider,
  coreBackend,
  crossrefBackend,
  europePmcBackend,
  localSearxngEngineNames,
  openAlexBackend,
  openCitationsBackend,
  presetRoutes,
  probeOpenRouterEmbeddings,
  searxngProvider,
  semanticScholarBackend,
  tavilyProvider,
  type EngineCanary,
  type EngineRoute,
  type PaperBackend,
  type ProviderFetch,
  type WebSearchProvider,
} from "@brainstorm-agentic/host-tools";
import {
  TOOL_PURPOSES,
  type AvailabilityProbeRequest,
  type AvailabilityReport,
  type PurposeOrder,
  type PurposeOrderEntry,
  type ReadinessCheck,
  type ServerSettings,
  type ToolAvailability,
  type ToolProbeLogLine,
  type ToolPurpose,
  type ToolState,
} from "@brainstorm-agentic/protocol";

import { atomicWriteJson, readJsonFile } from "./files.js";
import { BUILTIN_ENCODER_ID, LOCAL_ENCODER_IDS, panelCompositionOf } from "./panel-composition.js";
import { encoderReadiness as defaultEncoderReadiness, type EncoderReadiness } from "./readiness.js";
import { searxngDir, type SearxngStatus } from "./searxng-launcher.js";
import {
  availabilitySettingsOf,
  validateContentRegistryConnection,
  type SettingsStore,
} from "./settings.js";

/* ------------------------------------------------------------------------ */
/* Types: the protocol's (contract Section A), re-exported for the server's  */
/* own modules and tests; the derived order is host-tools' deriveEffectiveOrder */
/* ------------------------------------------------------------------------ */

export type {
  AvailabilityProbeRequest,
  AvailabilityReport,
  PurposeOrder,
  PurposeOrderEntry,
  ToolAvailability,
  ToolProbeLogLine,
  ToolPurpose,
  ToolState,
};
export { TOOL_PURPOSES, deriveEffectiveOrder };

export type ToolGroup = ToolAvailability["group"];

/* ------------------------------------------------------------------------ */
/* Tool catalog                                                              */
/* ------------------------------------------------------------------------ */

export const WEB_SEARCH_TOOL_IDS = ["searxng", "brave", "tavily"] as const;
export const PAPER_TOOL_IDS = [
  "openalex",
  "crossref",
  "arxiv",
  "semantic-scholar",
  "europepmc",
  "core",
  "opencitations",
] as const;
/** Every web source (general search and paper index) the manager may route to. */
export const WEB_TOOL_IDS: readonly string[] = [...WEB_SEARCH_TOOL_IDS, ...PAPER_TOOL_IDS];
export const ENCODER_TOOL_IDS: readonly string[] = [...LOCAL_ENCODER_IDS, BUILTIN_ENCODER_ID].map(
  (id) => `encoder:${id}`,
);
/** Every tool row, in display order (spec Section 1). */
export const TOOL_IDS: readonly string[] = [
  ...WEB_SEARCH_TOOL_IDS,
  ...PAPER_TOOL_IDS,
  "llm",
  "openrouter-embeddings",
  ...ENCODER_TOOL_IDS,
  "registry",
  "searxng-local",
  "code",
  "slurm",
];

const TOOL_LABELS: Readonly<Record<string, string>> = {
  searxng: "SearXNG",
  brave: "Brave Search",
  tavily: "Tavily",
  openalex: "OpenAlex",
  crossref: "Crossref",
  arxiv: "arXiv",
  "semantic-scholar": "Semantic Scholar",
  europepmc: "Europe PMC",
  core: "CORE",
  opencitations: "OpenCitations",
  llm: "Chat model",
  "openrouter-embeddings": "OpenRouter embeddings",
  registry: "Brain Registry",
  "searxng-local": "Local SearXNG",
  code: "Code workspace",
  slurm: "SLURM scheduler",
};

function toolLabel(id: string): string {
  if (id.startsWith("encoder:")) return `Encoder ${id.slice("encoder:".length)}`;
  if (id.startsWith("searxng:")) return id.slice("searxng:".length);
  return TOOL_LABELS[id] ?? id;
}

function toolGroup(id: string): ToolGroup {
  if ((WEB_SEARCH_TOOL_IDS as readonly string[]).includes(id) || id.startsWith("searxng:")) return "search";
  if ((PAPER_TOOL_IDS as readonly string[]).includes(id)) return "papers";
  if (id === "llm" || id === "openrouter-embeddings" || id.startsWith("encoder:")) return "models";
  return "infrastructure";
}

/** Default citation-hop order: the indexes that serve references/citations. */
export const DEFAULT_CITATION_HOP_ROUTE: readonly string[] = ["openalex", "semantic-scholar", "opencitations"];

/** The embedding model the OpenRouter probe asks for when no openrouter:<model> encoder is selected. */
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** Probe ceilings (spec Section 2): 8 s, arXiv 15 s. */
const PROBE_TIMEOUT_MS = 8_000;
const ARXIV_PROBE_TIMEOUT_MS = 15_000;
/** How long an unreachable/blocked tool waits before the cooldown re-probe. */
export const AVAILABILITY_COOLDOWN_MS = 10 * 60_000;
/** The tools whose probe is the readiness service's own check (see mirrorReadiness). */
export type MirroredCheckId = "llm" | "code" | "slurm";
/** Ceiling for mirroring a readiness probe (the SLURM probe job may queue). */
const READINESS_WAIT_MS: Readonly<Record<MirroredCheckId, number>> = { llm: 60_000, code: 60_000, slurm: 5 * 60_000 };

/* ------------------------------------------------------------------------ */
/* Probe plumbing: log, redaction, fetch wrapper                            */
/* ------------------------------------------------------------------------ */

const SECRET_QUERY_KEYS = /^(api[_-]?key|apikey|key|token|access[_-]?token|mailto)$/i;

/** Strips secrets from one log line: configured values, key query params, bearer tokens. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("***");
  }
  out = out.replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|mailto)=)[^&\s]*/gi, "$1***");
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***");
  out = out.replace(/((?:x-api-key|authorization)\s*[:=]\s*)\S+/gi, "$1***");
  return out;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.test(key)) parsed.searchParams.set(key, "***");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export class ProbeLog {
  readonly lines: ToolProbeLogLine[] = [];
  constructor(
    private readonly now: () => number,
    private readonly secrets: readonly string[],
  ) {}
  info(text: string): void {
    this.push("info", text);
  }
  warn(text: string): void {
    this.push("warn", text);
  }
  error(text: string): void {
    this.push("error", text);
  }
  private push(level: ToolProbeLogLine["level"], text: string): void {
    this.lines.push({ at: this.now(), level, text: redactSecrets(text, this.secrets) });
  }
}

/** Wraps a fetch so every request and response lands in the probe log. */
function loggingFetch(base: ProviderFetch, log: ProbeLog, now: () => number): ProviderFetch {
  return async (url, init) => {
    const method = init.method ?? "GET";
    const startedAt = now();
    log.info(`${method} ${redactUrl(url)}`);
    try {
      const response = await base(url, init);
      const elapsed = now() - startedAt;
      const line = `HTTP ${response.status} in ${elapsed} ms`;
      if (response.status >= 400) log.warn(line);
      else log.info(line);
      return response;
    } catch (error) {
      log.error(`request failed after ${now() - startedAt} ms: ${messageOf(error)}`);
      throw error;
    }
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Maps a failed request onto a state (spec Section 2). */
export function stateFromError(message: string): { state: ToolState; detail: string } {
  if (/HTTP (429|503)\b/.test(message)) return { state: "degraded", detail: message };
  if (/refused the API key|HTTP 401\b|invalid (api[_ -]?key|x-api-key)|authentication/i.test(message)) {
    return { state: "needs-key", detail: message };
  }
  if (/HTTP 403\b|captcha|access denied|blocked/i.test(message)) return { state: "blocked", detail: message };
  if (/HTTP 404\b/.test(message)) return { state: "degraded", detail: `answered without the known record (${message})` };
  return { state: "unreachable", detail: message };
}

/** Normalizes a host-tools WebSourceStatus onto the tool states of the spec. */
function stateFromSourceStatus(status: WebSourceStatus): { state: ToolState; detail?: string; until?: number } {
  const detail = status.detail;
  let state: ToolState;
  switch (status.state) {
    case "available":
    case "degraded":
    case "unreachable":
    case "needs-key":
    case "unchecked":
      state = status.state;
      break;
    case "blocked":
      // The spec reads a 429/503 on the probe as degraded, not blocked.
      state = detail !== undefined && /HTTP (429|503)\b/.test(detail) ? "degraded" : "blocked";
      break;
    case "not-configured":
      state = "disabled";
      break;
    default:
      state = "unchecked";
  }
  return {
    state,
    ...(detail !== undefined ? { detail } : {}),
    ...(status.until !== undefined ? { until: status.until } : {}),
  };
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/* ------------------------------------------------------------------------ */
/* Probes                                                                    */
/* ------------------------------------------------------------------------ */

export type ProbeReason = "start" | "manual" | "settings" | "periodic" | "cooldown";

export interface ProbeContext {
  readonly settings: ServerSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly signal: AbortSignal;
  /** The fetch every network probe goes through (already logging). */
  readonly fetchImpl: ProviderFetch;
  readonly log: ProbeLog;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly reason: ProbeReason;
}

export interface ProbeOutcome {
  readonly state: ToolState;
  readonly detail?: string;
  readonly keyPresent?: boolean;
  readonly until?: number;
  readonly children?: readonly ToolAvailability[];
}

export type ToolProbe = (context: ProbeContext) => Promise<ProbeOutcome>;

/** What the settings say about the web layer, read without throwing. */
interface WebSetup {
  readonly agentMode: boolean;
  readonly provider: "none" | "tavily" | "brave" | "searxng" | "searxng-local";
  readonly scholarly: boolean;
  readonly searxngBaseUrl?: string;
  readonly contactEmail?: string;
  readonly braveFallback: boolean;
}

function webSetupOf(settings: ServerSettings, searxngStatus: SearxngStatus): WebSetup {
  const web = settings.webSearch;
  const provider = web?.provider ?? "none";
  const localUrl = searxngStatus.state === "running" ? searxngStatus.url : undefined;
  const searxngBaseUrl =
    provider === "searxng-local" ? localUrl : provider === "searxng" ? web?.searxngBaseUrl : undefined;
  return {
    agentMode: web?.mode === "agent",
    provider,
    scholarly: web?.scholarly !== false,
    ...(searxngBaseUrl !== undefined ? { searxngBaseUrl } : {}),
    ...(web?.contactEmail !== undefined ? { contactEmail: web.contactEmail } : {}),
    braveFallback: web?.braveFallback?.enabled === true,
  };
}

/** The known-answer search a general provider must answer with at least one hit. */
const GENERAL_CANARY = { query: "Attention Is All You Need", pattern: /arxiv\.org|nips\.cc|neurips\.cc/i };

async function probeGeneralProvider(
  provider: WebSearchProvider,
  context: ProbeContext,
): Promise<ProbeOutcome> {
  const signal = withTimeout(context.signal, PROBE_TIMEOUT_MS);
  if (provider.check !== undefined) {
    const status = await checkWithLog(context.log, () => provider.check!(signal));
    return stateFromSourceStatus(status);
  }
  try {
    const answer = await provider.search({ query: GENERAL_CANARY.query, kind: "general", maxResults: 5, signal });
    const top = answer.hits.slice(0, 5);
    context.log.info(`${top.length} result(s) for "${GENERAL_CANARY.query}"`);
    if (top.length === 0) return { state: "degraded", detail: "answered with no results" };
    return top.some((hit) => GENERAL_CANARY.pattern.test(hit.url))
      ? { state: "available", detail: `${top.length} results` }
      : { state: "degraded", detail: "answered without the known page in the top five" };
  } catch (error) {
    const mapped = stateFromError(messageOf(error));
    context.log.error(mapped.detail);
    return mapped;
  }
}

type StatusWithLog = WebSourceStatus & { readonly log?: readonly ToolProbeLogLine[] };

/**
 * Runs a host-tools check and merges its log: a check that records its own
 * lines (request summary, status, counts, timing) replaces the fetch-level
 * lines this service recorded meanwhile, so nothing is logged twice.
 */
async function checkWithLog(log: ProbeLog, check: () => Promise<StatusWithLog>): Promise<StatusWithLog> {
  const mark = log.lines.length;
  const status = await check();
  if (status.log !== undefined && status.log.length > 0) {
    log.lines.splice(mark);
    for (const line of status.log) {
      if (line.level === "error") log.error(line.text);
      else if (line.level === "warn") log.warn(line.text);
      else log.info(line.text);
    }
  }
  log.info(`${status.id}: ${status.state}${status.detail !== undefined ? ` — ${status.detail}` : ""}`);
  return status;
}

async function probeBackend(backend: PaperBackend, context: ProbeContext, timeoutMs: number): Promise<ProbeOutcome> {
  if (!backend.ready.ok) return { state: "needs-key", detail: backend.ready.reason };
  const signal = withTimeout(context.signal, timeoutMs);
  if (backend.check !== undefined) {
    const status = await checkWithLog(context.log, () => backend.check!(signal));
    return stateFromSourceStatus(status);
  }
  return { state: "unchecked", detail: `${backend.id} has no probe` };
}

/* ---- SearXNG and its engines ------------------------------------------- */

type EngineAsk = (engine: string, canary: EngineCanary, signal?: AbortSignal) => Promise<{ readonly urls: readonly string[]; readonly failure?: string }>;

function engineAsk(provider: WebSearchProvider, log: ProbeLog, perEngine: Map<string, ProbeLog>, now: () => number, secrets: readonly string[]): EngineAsk {
  return async (engine, canary, signal) => {
    const own = perEngine.get(engine) ?? new ProbeLog(now, secrets);
    perEngine.set(engine, own);
    const startedAt = now();
    try {
      const answer = await provider.search({
        query: canary.query,
        kind: canary.route === "news" ? "news" : "general",
        maxResults: 5,
        engines: [engine],
        route: canary.route === "paper-science" ? "paper-topic" : canary.route,
        ...(signal !== undefined ? { signal } : {}),
      });
      const failure = answer.engineFailures?.find((entry) => entry.engine === engine)?.reason;
      const urls = answer.hits.map((hit) => hit.url);
      const line = `${engine}: "${canary.query}" → ${urls.length} result(s) in ${now() - startedAt} ms${
        failure !== undefined && urls.length === 0 ? ` (${failure})` : ""
      }`;
      log.info(line);
      own.info(line);
      return { urls, ...(failure !== undefined && urls.length === 0 ? { failure } : {}) };
    } catch (error) {
      const line = `${engine}: "${canary.query}" failed after ${now() - startedAt} ms: ${messageOf(error)}`;
      log.error(line);
      own.error(line);
      return { urls: [], failure: messageOf(error) };
    }
  };
}

/** The engines the launched instance schedules, per route, restricted to `only` when given. */
function engineRoutes(only?: readonly string[]): Partial<Record<EngineRoute, readonly string[]>> {
  const byRoute: Partial<Record<EngineRoute, readonly string[]>> = {};
  for (const [route, names] of Object.entries(LOCAL_SEARXNG_ENGINES) as [EngineRoute, readonly string[]][]) {
    const picked = only === undefined ? names : names.filter((name) => only.includes(name));
    if (picked.length > 0) byRoute[route] = picked;
  }
  return byRoute;
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

export interface AvailabilityServiceOptions {
  readonly workspace: string;
  readonly settings: SettingsStore;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: injected into every network probe. */
  readonly fetchImpl?: ProviderFetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The registry probe; default validateContentRegistryConnection. */
  readonly registryClient?: (url: string, bundle: string, version?: string) => Promise<void>;
  /** The encoder inventory; default encoderReadiness. */
  readonly encoderReadiness?: (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly openRouterKeyConfigured: boolean;
    readonly selected?: string;
  }) => EncoderReadiness;
  /** The app-launched SearXNG's live state (the launcher's status()). */
  readonly searxngStatus?: () => SearxngStatus;
  /** The readiness checks, live, for llm, code and slurm (their outcome is mirrored). */
  readonly readinessChecks?: () => readonly ReadinessCheck[];
  /** Re-runs readiness checks (a manual probe of llm/code/slurm asks for a fresh outcome). */
  readonly refreshReadiness?: (ids: readonly MirroredCheckId[]) => void;
  /** Per-tool probe overrides (test seam / special deployments). */
  readonly probeOverrides?: Readonly<Record<string, ToolProbe>>;
}

interface MutableTool {
  readonly id: string;
  state: ToolState;
  keyPresent?: boolean;
  latencyMs?: number;
  detail?: string;
  checkedAt?: number;
  until?: number;
  probing: boolean;
  log: readonly ToolProbeLogLine[];
  children?: readonly ToolAvailability[];
}

interface PersistedReport {
  readonly version?: number;
  readonly tools?: readonly ToolAvailability[];
}

export interface ProbeOptions {
  /** Return after this long even if probes are still running (they finish in the background). */
  readonly waitMs?: number;
  readonly reason?: ProbeReason;
}

export class AvailabilityService {
  private readonly tools = new Map<string, MutableTool>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(report: AvailabilityReport) => void>();
  private readonly controller = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly baseFetch: ProviderFetch;
  private readonly persistPath: string;
  private timer: NodeJS.Timeout | undefined;
  private lastFullProbeAt: number | undefined;
  /** Set by close(): no more probes, persistence or listeners; reports keep answering. */
  private closed = false;
  /** The last report built from readable settings (what report() falls back to). */
  private lastReport: AvailabilityReport | undefined;

  constructor(private readonly options: AvailabilityServiceOptions) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          const onAbort = (): void => {
            clearTimeout(timeout);
            reject(new Error("aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        }));
    this.baseFetch = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
    // Availability contains host-specific service health and routing. An old
    // desktop backend sharing the home directory must not seed this server's
    // workers with its failed local providers or overwrite their route order.
    this.persistPath = join(
      options.settings.searxngInstanceId === undefined
        ? options.workspace
        : searxngDir(options.workspace, options.settings.searxngInstanceId),
      "availability.json",
    );
    for (const id of TOOL_IDS) this.tools.set(id, { id, state: "unchecked", probing: false, log: [] });
    this.load();
  }

  /** The last persisted table, so a relaunch shows known state until the start probe lands. */
  private load(): void {
    let persisted: PersistedReport | undefined;
    try {
      persisted = readJsonFile<PersistedReport>(this.persistPath);
    } catch {
      return;
    }
    if (persisted?.version !== 1) return;
    for (const entry of persisted.tools ?? []) {
      const tool = this.tools.get(entry.id);
      if (!tool) continue;
      tool.state = entry.state;
      tool.keyPresent = entry.keyPresent;
      tool.latencyMs = entry.latencyMs;
      tool.detail = entry.detail;
      tool.checkedAt = entry.checkedAt;
      tool.until = entry.until;
      tool.log = Array.isArray(entry.log) ? entry.log : [];
      tool.children = entry.children;
    }
  }

  private persist(): void {
    try {
      atomicWriteJson(this.persistPath, this.report());
    } catch {
      // Persistence is a convenience; never fail a probe over it.
    }
  }

  private emit(): void {
    // After close() the workspace may be gone and the listeners' server with
    // it: a probe that finishes late changes nothing outside this object.
    if (this.closed) return;
    this.persist();
    const report = this.report();
    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  subscribe(listener: (report: AvailabilityReport) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private settings(): ServerSettings {
    return this.options.settings.get();
  }

  private searxngStatus(): SearxngStatus {
    return this.options.searxngStatus?.() ?? { state: "off" };
  }

  /** Every configured secret, for log redaction. */
  private secrets(): readonly string[] {
    const store = this.options.settings;
    return [
      store.getAnthropicApiKey(),
      store.getClaudeSetupToken(),
      store.getCursorApiKey(),
      store.getOpenRouterApiKey(),
      store.getTavilyApiKey(),
      store.getBraveApiKey(),
      store.getSemanticScholarApiKey(),
      store.getOpenAlexApiKey(),
      store.getCoreApiKey(),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  /** The ids probe() accepts: every tool row plus the SearXNG engine sub-rows. */
  knownIds(): readonly string[] {
    return [...TOOL_IDS, ...localSearxngEngineNames().map((engine) => `searxng:${engine}`)];
  }

  /* ---- report ------------------------------------------------------------ */

  /**
   * The table and the derived orders. Never throws: when the settings cannot
   * be read (a torn write, or the workspace removed after close()) the tools
   * are reported as they are with the last derived orders.
   */
  report(): AvailabilityReport {
    const tools = TOOL_IDS.map((id) => this.view(this.tools.get(id)!));
    let settings: ServerSettings;
    try {
      settings = this.settings();
    } catch {
      return {
        version: 1,
        updatedAt: this.now(),
        tools,
        purposes: this.lastReport?.purposes ?? [],
        demoteDegraded: this.lastReport?.demoteDegraded ?? true,
      };
    }
    const { demoteDegraded } = availabilitySettingsOf(settings);
    const report: AvailabilityReport = {
      version: 1,
      updatedAt: this.now(),
      tools,
      purposes: this.purposes(settings, tools, demoteDegraded),
      demoteDegraded,
    };
    this.lastReport = report;
    return report;
  }

  private view(tool: MutableTool): ToolAvailability {
    return {
      id: tool.id,
      label: toolLabel(tool.id),
      group: toolGroup(tool.id),
      state: tool.state,
      ...(tool.keyPresent !== undefined ? { keyPresent: tool.keyPresent } : {}),
      ...(tool.latencyMs !== undefined ? { latencyMs: tool.latencyMs } : {}),
      ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
      ...(tool.checkedAt !== undefined ? { checkedAt: tool.checkedAt } : {}),
      ...(tool.until !== undefined ? { until: tool.until } : {}),
      ...(tool.probing ? { probing: true } : {}),
      log: tool.log,
      ...(tool.children !== undefined ? { children: tool.children } : {}),
    };
  }

  /** The configured list per purpose (settings.webSearch.routes over the preset; encoder choice). */
  configuredOrders(settings: ServerSettings = this.settings()): Readonly<Record<ToolPurpose, readonly string[]>> {
    const web = settings.webSearch;
    const provider = web?.provider ?? "none";
    const primary =
      provider === "none" ? undefined : provider === "searxng-local" ? "searxng" : provider;
    const preset = presetRoutes(web?.routePreset ?? "searxng-first", primary);
    const routes = (web as unknown as { readonly routes?: Partial<Record<string, readonly string[]>> } | undefined)?.routes ?? {};
    const selected = selectedEncoder(settings);
    const selectedId = selected.startsWith("openrouter:") ? "openrouter-embeddings" : `encoder:${selected}`;
    return {
      web: routes.web ?? preset.web,
      news: routes.news ?? preset.news,
      "paper-lookup": routes["paper-lookup"] ?? preset["paper-lookup"],
      "paper-topic": routes["paper-topic"] ?? preset["paper-topic"],
      "paper-details": routes["paper-details"] ?? preset["paper-details"],
      "citation-hop": routes["citation-hop"] ?? DEFAULT_CITATION_HOP_ROUTE,
      embedding: routes.embedding ?? [...new Set([selectedId, `encoder:${BUILTIN_ENCODER_ID}`])],
    };
  }

  private purposes(settings: ServerSettings, tools: readonly ToolAvailability[], demoteDegraded: boolean): PurposeOrder[] {
    const states = new Map<string, ToolState>();
    for (const tool of tools) {
      states.set(tool.id, tool.state);
      for (const child of tool.children ?? []) states.set(child.id, child.state);
    }
    // "searxng:science" is SearXNG's science engines: it stands or falls with
    // the europepmc engine when the engines were checked, else with SearXNG.
    const searxng = states.get("searxng") ?? "unchecked";
    states.set("searxng:science", states.get("searxng:europepmc") ?? searxng);
    const configured = this.configuredOrders(settings);
    return TOOL_PURPOSES.map((purpose) => ({ purpose, ...deriveEffectiveOrder(configured[purpose], states, demoteDegraded) }));
  }

  /* ---- probing ----------------------------------------------------------- */

  probeAll(options: ProbeOptions = {}): Promise<AvailabilityReport> {
    this.lastFullProbeAt = this.now();
    return this.probe(TOOL_IDS, options);
  }

  /**
   * Probes the named tools (unknown ids are ignored; a tool already being
   * probed is not started twice). Resolves with the table once every probe
   * finished — or after `waitMs`, in which case the slow ones keep running
   * and show probing: true. Never rejects: a probe's failure (a settings
   * read included) is recorded on its tool, and after close() the call
   * resolves quietly with the last table.
   */
  async probe(ids: readonly string[], options: ProbeOptions = {}): Promise<AvailabilityReport> {
    if (this.closed) return this.report();
    const reason = options.reason ?? "manual";
    const started: Promise<void>[] = [];
    const engines = new Set<string>();
    for (const raw of new Set(ids)) {
      if (raw.startsWith("searxng:")) {
        engines.add(raw.slice("searxng:".length));
        continue;
      }
      if (!this.tools.has(raw)) continue;
      const running = this.inFlight.get(raw);
      if (running !== undefined) {
        started.push(running);
        continue;
      }
      started.push(this.start(raw, reason, undefined));
    }
    if (engines.size > 0 && !ids.includes("searxng")) {
      const running = this.inFlight.get("searxng");
      started.push(running ?? this.start("searxng", reason, [...engines]));
    }
    if (started.length > 0) this.emit();
    const all = Promise.all(started).then(() => undefined);
    const waitMs = options.waitMs;
    if (waitMs === undefined) {
      await all;
    } else {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        all,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    return this.report();
  }

  private start(id: string, reason: ProbeReason, engines: readonly string[] | undefined): Promise<void> {
    const tool = this.tools.get(id)!;
    tool.probing = true;
    const task = this.run(tool, reason, engines)
      .catch(() => undefined)
      .finally(() => {
        tool.probing = false;
        this.inFlight.delete(id);
        this.emit();
      });
    this.inFlight.set(id, task);
    return task;
  }

  private async run(tool: MutableTool, reason: ProbeReason, engines: readonly string[] | undefined): Promise<void> {
    const startedAt = this.now();
    // The settings and secrets are read per probe so a save between two
    // probes is seen; a read that fails is this probe's error, nothing more.
    let settings: ServerSettings;
    let log: ProbeLog;
    try {
      settings = this.settings();
      log = new ProbeLog(this.now, this.secrets());
    } catch (error) {
      if (this.closed) return;
      const failed = new ProbeLog(this.now, []);
      failed.info(`probe ${tool.id} (${reason})`);
      failed.error(`settings could not be read: ${messageOf(error)}`);
      tool.state = "unchecked";
      tool.detail = `probe failed: settings could not be read (${messageOf(error)})`;
      tool.latencyMs = this.now() - startedAt;
      tool.checkedAt = this.now();
      tool.log = failed.lines;
      return;
    }
    log.info(`probe ${tool.id} (${reason})`);
    const context: ProbeContext = {
      settings,
      env: this.env,
      workspace: this.options.workspace,
      signal: this.controller.signal,
      fetchImpl: loggingFetch(this.baseFetch, log, this.now),
      log,
      now: this.now,
      sleep: this.sleep,
      reason,
    };
    let outcome: ProbeOutcome;
    try {
      const override = this.options.probeOverrides?.[tool.id];
      outcome = override !== undefined ? await override(context) : await this.defaultProbe(tool.id, context, engines);
    } catch (error) {
      if (this.closed || this.controller.signal.aborted) return;
      const mapped = stateFromError(messageOf(error));
      log.error(mapped.detail);
      outcome = mapped;
    }
    if (this.closed) return;
    const finishedAt = this.now();
    log.info(`${tool.id}: ${outcome.state} in ${finishedAt - startedAt} ms`);
    tool.state = outcome.state;
    tool.detail = outcome.detail;
    tool.keyPresent = outcome.keyPresent;
    tool.until = outcome.until;
    tool.latencyMs = finishedAt - startedAt;
    tool.checkedAt = finishedAt;
    tool.log = log.lines;
    if (outcome.children !== undefined) {
      // A partial engine check keeps the other engines' rows as they were.
      const previous = new Map((tool.children ?? []).map((child) => [child.id, child] as const));
      for (const child of outcome.children) previous.set(child.id, child);
      tool.children = [...previous.values()];
    } else if (tool.id === "searxng" && (outcome.state === "disabled" || outcome.state === "needs-key")) {
      tool.children = undefined;
    }
  }

  /* ---- the probes -------------------------------------------------------- */

  private async defaultProbe(id: string, context: ProbeContext, engines: readonly string[] | undefined): Promise<ProbeOutcome> {
    const store = this.options.settings;
    const settings = context.settings;
    const web = webSetupOf(settings, this.searxngStatus());
    const fetchImpl = context.fetchImpl;
    const webDisabled = (): ProbeOutcome | undefined =>
      web.agentMode ? { state: "disabled", detail: "search is handed to the agents' own tools (webSearch.mode = agent)" } : undefined;
    const paperDisabled = (): ProbeOutcome | undefined =>
      webDisabled() ?? (web.scholarly ? undefined : { state: "disabled", detail: "the scholarly chain is switched off (webSearch.scholarly)" });

    switch (id) {
      case "tavily": {
        const key = store.getTavilyApiKey();
        if (key === undefined) return webDisabled() ?? { state: "needs-key", keyPresent: false, detail: "no Tavily API key configured" };
        const disabled = webDisabled();
        if (disabled !== undefined) return { ...disabled, keyPresent: true };
        return { keyPresent: true, ...(await probeGeneralProvider(tavilyProvider({ apiKey: key, fetchImpl }), context)) };
      }
      case "brave": {
        const key = store.getBraveApiKey();
        if (key === undefined) return webDisabled() ?? { state: "needs-key", keyPresent: false, detail: "no Brave Search API key configured" };
        const disabled = webDisabled();
        if (disabled !== undefined) return { ...disabled, keyPresent: true };
        return { keyPresent: true, ...(await probeGeneralProvider(braveProvider({ apiKey: key, fetchImpl }), context)) };
      }
      case "searxng": {
        const disabled = webDisabled();
        if (disabled !== undefined) return disabled;
        if (web.provider !== "searxng" && web.provider !== "searxng-local") {
          return { state: "disabled", detail: "SearXNG is not the selected general provider" };
        }
        if (web.searxngBaseUrl === undefined) {
          const local = this.searxngStatus();
          return {
            state: "unreachable",
            detail:
              web.provider === "searxng-local"
                ? `local SearXNG is ${local.state}${local.detail !== undefined ? `: ${local.detail}` : ""}`
                : "no SearXNG base URL configured",
          };
        }
        const provider = searxngProvider({ baseUrl: web.searxngBaseUrl, fetchImpl });
        if (web.provider !== "searxng-local") return probeGeneralProvider(provider, context);
        // The launched instance runs exactly the scheduled engines: one
        // sub-row per engine, two known-answer queries each (the same check
        // the run's manager performs).
        const perEngine = new Map<string, ProbeLog>();
        const pool = new EnginePool({
          byRoute: engineRoutes(engines),
          clock: { now: this.now, sleep: this.sleep, random: Math.random },
        });
        const table = await pool.check(
          DEFAULT_ENGINE_CANARIES,
          engineAsk(provider, context.log, perEngine, this.now, this.secrets()),
          withTimeout(context.signal, 4 * PROBE_TIMEOUT_MS),
        );
        const children = table.map((entry): ToolAvailability => {
          const mapped = stateFromSourceStatus(entry);
          return {
            id: `searxng:${entry.id}`,
            label: entry.id,
            group: "search",
            state: mapped.state,
            ...(mapped.detail !== undefined ? { detail: mapped.detail } : {}),
            ...(entry.checkedAt !== undefined ? { checkedAt: entry.checkedAt } : {}),
            ...(mapped.until !== undefined ? { until: mapped.until } : {}),
            log: perEngine.get(entry.id)?.lines ?? [],
          };
        });
        if (engines !== undefined) {
          // A single engine was asked for: the parent keeps its own state.
          const parent = this.tools.get("searxng")!;
          return {
            state: parent.state === "unchecked" ? "unchecked" : parent.state,
            ...(parent.detail !== undefined ? { detail: parent.detail } : {}),
            children,
          };
        }
        const usable = table.filter((entry) => entry.state === "available" || entry.state === "degraded").length;
        return {
          state: usable > 0 ? (usable === table.length ? "available" : "degraded") : "unreachable",
          detail: `${usable} of ${table.length} engines usable`,
          children,
        };
      }
      case "openalex": {
        const key = store.getOpenAlexApiKey();
        const disabled = paperDisabled();
        if (disabled !== undefined) return { ...disabled, keyPresent: key !== undefined };
        // Never a keyless call: OpenAlex is only asked with an API key.
        if (key === undefined) {
          return { state: "needs-key", keyPresent: false, detail: "OpenAlex is only called with an API key (webSearch.openAlexApiKey)" };
        }
        return { keyPresent: true, ...(await probeBackend(openAlexBackend({ apiKey: key, fetchImpl }), context, PROBE_TIMEOUT_MS)) };
      }
      case "crossref": {
        const disabled = paperDisabled();
        if (disabled !== undefined) return disabled;
        return probeBackend(
          crossrefBackend({ ...(web.contactEmail !== undefined ? { contactEmail: web.contactEmail } : {}), fetchImpl }),
          context,
          PROBE_TIMEOUT_MS,
        );
      }
      case "arxiv": {
        const disabled = paperDisabled();
        if (disabled !== undefined) return disabled;
        return probeBackend(arxivBackend({ fetchImpl }), context, ARXIV_PROBE_TIMEOUT_MS);
      }
      case "semantic-scholar": {
        const key = store.getSemanticScholarApiKey();
        const disabled = paperDisabled();
        if (disabled !== undefined) return { ...disabled, keyPresent: key !== undefined };
        return {
          keyPresent: key !== undefined,
          ...(await probeBackend(semanticScholarBackend({ ...(key !== undefined ? { apiKey: key } : {}), fetchImpl }), context, PROBE_TIMEOUT_MS)),
        };
      }
      case "europepmc": {
        const disabled = paperDisabled();
        if (disabled !== undefined) return disabled;
        return probeBackend(europePmcBackend({ fetchImpl }), context, PROBE_TIMEOUT_MS);
      }
      case "core": {
        const key = store.getCoreApiKey();
        const disabled = paperDisabled();
        if (disabled !== undefined) return { ...disabled, keyPresent: key !== undefined };
        if (key === undefined) return { state: "needs-key", keyPresent: false, detail: "CORE needs an API key (webSearch.coreApiKey)" };
        return { keyPresent: true, ...(await probeBackend(coreBackend({ apiKey: key, fetchImpl }), context, PROBE_TIMEOUT_MS)) };
      }
      case "opencitations": {
        const disabled = paperDisabled();
        if (disabled !== undefined) return disabled;
        return probeBackend(openCitationsBackend({ fetchImpl }), context, PROBE_TIMEOUT_MS);
      }
      case "llm":
        return this.mirrorReadiness("llm", context);
      case "openrouter-embeddings": {
        const key = store.getOpenRouterApiKey();
        if (key === undefined) return { state: "needs-key", keyPresent: false, detail: "needs the OpenRouter API key (Recovery settings)" };
        const selected = selectedEncoder(settings);
        const model = selected.startsWith("openrouter:") ? selected.slice("openrouter:".length) : DEFAULT_OPENROUTER_EMBEDDING_MODEL;
        const status = await checkWithLog(context.log, () =>
          probeOpenRouterEmbeddings(key, model, fetchImpl, { signal: context.signal, now: this.now }),
        );
        return { keyPresent: true, ...stateFromSourceStatus(status) };
      }
      case "registry": {
        const registry = settings.contentRegistry;
        const probe = this.options.registryClient ?? validateContentRegistryConnection;
        context.log.info(`resolve bundle ${registry.bundle}${registry.version !== undefined ? `@${registry.version}` : ""} at ${registry.url}`);
        try {
          await probe(registry.url, registry.bundle, registry.version);
          return { state: "available", detail: registry.url };
        } catch (error) {
          const message = messageOf(error);
          context.log.error(message);
          return { state: "unreachable", detail: message };
        }
      }
      case "searxng-local": {
        if (web.agentMode || web.provider !== "searxng-local") {
          return { state: "disabled", detail: "the app-launched SearXNG is not selected (webSearch.provider)" };
        }
        const local = this.searxngStatus();
        context.log.info(`launcher state: ${local.state}${local.url !== undefined ? ` at ${local.url}` : ""}${local.detail !== undefined ? ` — ${local.detail}` : ""}`);
        switch (local.state) {
          case "running":
            return { state: "available", ...(local.url !== undefined ? { detail: local.url } : {}) };
          case "starting":
            return { state: "degraded", detail: local.detail ?? "starting" };
          case "failed":
            return { state: "unreachable", detail: local.detail ?? "the launcher failed" };
          case "off":
            return { state: "unreachable", detail: local.detail ?? "not running" };
          default:
            return { state: "unchecked" };
        }
      }
      case "code":
        return this.mirrorReadiness("code", context);
      case "slurm":
        if (settings.runner !== "slurm") return { state: "disabled", detail: "runner is local (SLURM not used)" };
        return this.mirrorReadiness("slurm", context);
      default: {
        if (id.startsWith("encoder:")) return this.probeEncoder(id.slice("encoder:".length), context);
        return { state: "unchecked", detail: `unknown tool ${id}` };
      }
    }
  }

  private async probeEncoder(encoderId: string, context: ProbeContext): Promise<ProbeOutcome> {
    const inventory = (this.options.encoderReadiness ?? defaultEncoderReadiness)({
      env: context.env,
      openRouterKeyConfigured: context.settings.creditRecovery.openRouterKeyConfigured === true,
      selected: selectedEncoder(context.settings),
    });
    const entry = inventory.encoders.find((encoder) => encoder.id === encoderId);
    if (entry === undefined) return { state: "unchecked", detail: `no inventory entry for ${encoderId}` };
    context.log.info(`${encoderId}: ${entry.detail}`);
    return entry.available ? { state: "available", detail: entry.detail } : { state: "unreachable", detail: entry.detail };
  }

  /**
   * llm, code and slurm: the readiness probes own these checks (the model
   * connection through the configured provider's validate*Connection, the
   * code workspace build, the SLURM probe job); their outcome is mirrored
   * here so neither a real model request nor a probe job is ever made twice
   * for one trigger. A manual probe asks readiness for a fresh run and waits
   * for it; start, settings, periodic and cooldown probes read the current
   * outcome (readiness re-verifies on those triggers itself where it costs
   * nothing it would not spend anyway), waiting while a check is running.
   */
  private async mirrorReadiness(id: MirroredCheckId, context: ProbeContext): Promise<ProbeOutcome> {
    const checks = this.options.readinessChecks;
    if (checks === undefined) return { state: "unchecked", detail: "readiness checks are not wired" };
    const requestedAt = this.now();
    const fresh = context.reason === "manual";
    if (fresh) {
      this.options.refreshReadiness?.([id]);
      context.log.info(`asked the readiness service to re-run the ${id} check`);
    }
    const deadline = requestedAt + READINESS_WAIT_MS[id];
    for (;;) {
      const check = checks().find((entry) => entry.id === id);
      if (check === undefined) return { state: "unchecked", detail: `no readiness check named ${id}` };
      const settled = check.state !== "checking" && (!fresh || (check.finishedAt ?? 0) >= requestedAt || check.state === "skipped");
      if (settled) {
        context.log.info(`readiness ${id}: ${check.state}${check.message !== undefined ? ` — ${check.message}` : ""}`);
        if (check.detail !== undefined) context.log.info(check.detail);
        const detail = check.message !== undefined ? { detail: check.message } : {};
        const keyPresent = id === "llm" ? { keyPresent: llmKeyPresent(context.settings) } : {};
        switch (check.state) {
          case "ok":
            return { state: "available", ...keyPresent, ...detail };
          case "failed":
            // The model connection: no credential is needs-key, a rate limit
            // or overload is degraded, anything else unreachable.
            if (id === "llm" && !llmKeyPresent(context.settings)) return { state: "needs-key", keyPresent: false, ...detail };
            if (id === "llm" && /HTTP (429|503|529)\b|overloaded|rate limit/i.test(`${check.message ?? ""}\n${check.detail ?? ""}`)) {
              return { state: "degraded", ...keyPresent, ...detail };
            }
            return { state: "unreachable", ...keyPresent, ...detail };
          case "skipped":
            return { state: "disabled", ...keyPresent, ...detail };
          default:
            if (!fresh) return { state: "unchecked", ...keyPresent, ...detail };
        }
      }
      if (this.now() >= deadline) {
        context.log.warn(`readiness ${id} still running after ${READINESS_WAIT_MS[id] / 1000} s`);
        return { state: "unchecked", detail: `the readiness ${id} check is still running` };
      }
      await this.sleep(250, context.signal);
    }
  }

  /* ---- timers ------------------------------------------------------------ */

  /**
   * The tools whose cooldown has elapsed: unreachable or blocked, checked
   * more than ten minutes ago (or past their own `until`). Exposed for tests.
   */
  cooldownDue(): readonly string[] {
    const now = this.now();
    return TOOL_IDS.filter((id) => {
      const tool = this.tools.get(id)!;
      if (tool.probing || (tool.state !== "unreachable" && tool.state !== "blocked")) return false;
      const until = tool.until ?? (tool.checkedAt ?? 0) + AVAILABILITY_COOLDOWN_MS;
      return now >= until;
    });
  }

  /** Whether the slow full re-check (settings availability.periodicMinutes) is due. */
  periodicDue(): boolean {
    const { periodicMinutes } = availabilitySettingsOf(this.settings());
    // (a settings read failure propagates to tick(), which skips the scan)
    const last = this.lastFullProbeAt;
    return last === undefined || this.now() - last >= periodicMinutes * 60_000;
  }

  /** One scan of the timers; what startTimers runs on every tick. Exposed for tests. */
  tick(): void {
    if (this.closed) return;
    try {
      if (this.periodicDue()) {
        void this.probeAll({ reason: "periodic" }).catch(() => undefined);
        return;
      }
      const due = this.cooldownDue();
      if (due.length > 0) void this.probe(due, { reason: "cooldown" }).catch(() => undefined);
    } catch {
      // periodicDue reads the settings; an unreadable file skips this tick.
    }
  }

  startTimers(scanMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), scanMs);
    this.timer.unref();
  }

  /**
   * Stops the timers and aborts every in-flight probe. Probes that were
   * mid-request finish quietly without touching the workspace or the
   * listeners; probe() and report() keep answering with the last table.
   */
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort();
  }
}

/** Whether the configured chat provider has its credential. */
function llmKeyPresent(settings: ServerSettings): boolean {
  switch (settings.llm.provider) {
    case "anthropic":
      return settings.llm.apiKeyConfigured === true;
    case "claude-agent":
      return settings.llm.setupTokenConfigured === true;
    case "cursor-agent":
      return settings.llm.cursorApiKeyConfigured === true;
    default:
      return false;
  }
}

/** The encoder new runs ask for (panel composition override, else the spec default). */
function selectedEncoder(settings: ServerSettings): string {
  const selected = panelCompositionOf(settings)?.params.encoder;
  return typeof selected === "string" && selected !== "" ? selected : "specter2";
}

/* ------------------------------------------------------------------------ */
/* Settings diff (spec Section 3 b)                                         */
/* ------------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The tools a settings save affects: compares the public settings before and
 * after, and looks at the submitted body for freshly pasted secrets (a new key
 * for a provider that already had one changes nothing visible in the
 * settings). Returns the ids to re-probe, deduplicated, in table order.
 */
export function affectedTools(before: ServerSettings, after: ServerSettings, body: unknown = undefined): readonly string[] {
  const affected = new Set<string>();
  const add = (...ids: readonly string[]): void => {
    for (const id of ids) affected.add(id);
  };
  const patch = asRecord(body);
  const webPatch = asRecord(patch.webSearch);
  const llmPatch = asRecord(patch.llm);
  const recoveryPatch = asRecord(patch.creditRecovery);
  const b = before.webSearch;
  const a = after.webSearch;

  if (b?.mode !== a?.mode) add(...WEB_TOOL_IDS, "searxng-local");
  if (b?.provider !== a?.provider) add("tavily", "brave", "searxng", "searxng-local");
  if (b?.searxngBaseUrl !== a?.searxngBaseUrl) add("searxng");
  if (b?.scholarly !== a?.scholarly) add(...PAPER_TOOL_IDS);
  if (b?.contactEmail !== a?.contactEmail) add("crossref");
  if (b?.braveFallback?.enabled !== a?.braveFallback?.enabled) add("brave");
  if (b?.tavilyKeyConfigured !== a?.tavilyKeyConfigured || webPatch.tavilyApiKey !== undefined) add("tavily");
  if (b?.braveKeyConfigured !== a?.braveKeyConfigured || webPatch.braveApiKey !== undefined) add("brave");
  if (b?.semanticScholarKeyConfigured !== a?.semanticScholarKeyConfigured || webPatch.semanticScholarApiKey !== undefined) {
    add("semantic-scholar");
  }
  if (b?.openAlexKeyConfigured !== a?.openAlexKeyConfigured || webPatch.openAlexApiKey !== undefined) add("openalex");
  const coreBefore = (b as unknown as { coreKeyConfigured?: boolean } | undefined)?.coreKeyConfigured;
  const coreAfter = (a as unknown as { coreKeyConfigured?: boolean } | undefined)?.coreKeyConfigured;
  if (coreBefore !== coreAfter || webPatch.coreApiKey !== undefined) add("core");

  if (
    before.llm.provider !== after.llm.provider ||
    before.llm.model !== after.llm.model ||
    before.llm.baseUrl !== after.llm.baseUrl ||
    before.llm.apiKeyConfigured !== after.llm.apiKeyConfigured ||
    before.llm.setupTokenConfigured !== after.llm.setupTokenConfigured ||
    before.llm.cursorApiKeyConfigured !== after.llm.cursorApiKeyConfigured ||
    llmPatch.apiKey !== undefined ||
    llmPatch.setupToken !== undefined ||
    llmPatch.cursorApiKey !== undefined
  ) {
    add("llm");
  }
  if (
    before.creditRecovery.openRouterKeyConfigured !== after.creditRecovery.openRouterKeyConfigured ||
    recoveryPatch.openRouterApiKey !== undefined
  ) {
    add("openrouter-embeddings", ...ENCODER_TOOL_IDS);
  }
  const toolsBefore = [...(before.hostTools?.enabledToolIds ?? [])].sort().join(",");
  const toolsAfter = [...(after.hostTools?.enabledToolIds ?? [])].sort().join(",");
  if (toolsBefore !== toolsAfter) add("code");
  if (selectedEncoder(before) !== selectedEncoder(after)) add("openrouter-embeddings", ...ENCODER_TOOL_IDS);
  if (before.runner !== after.runner) add("slurm");

  return TOOL_IDS.filter((id) => affected.has(id));
}
