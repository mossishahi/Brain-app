/**
 * Deployment configuration -> WebAccessManager.
 *
 * The CONFIG is plain JSON (it rides the submission environment as
 * BRAINSTORM_AGENTIC_WEB_SEARCH and is snapshotted like every other run
 * setting); the SECRETS arrive separately, from the scheduler environment or
 * the owner-only credentials file, and never appear inside the JSON config.
 *
 * Chains built here:
 * - scholarly (default ON, keyless): OpenAlex -> Crossref -> arXiv ->
 *   Semantic Scholar. Keys, when configured, only raise rate limits.
 * - general/news: the provider the deployment selected (tavily, brave, or a
 *   self-hosted searxng), plus — when enabled with its key — the paid Brave
 *   Search API as the last resort. Unconfigured means the chain is empty and
 *   a general query gets an explicit configuration error naming the fix —
 *   never a silent degradation, and never a provider guessed at.
 * - routes: web, news, paper lookup, paper topic and paper details each get
 *   an ordered list from the preset ("searxng-first" by default, or
 *   "api-first"), or from an explicit per-route override.
 * - mode "agent": the deployment handed search to the agents' own tools, so
 *   no manager is built at all.
 */
import type {
  PaperDetailsAnswer,
  PaperSearchAnswer,
  WebSearchAnswer,
  WebSearchKind,
  WebSearchRoute,
} from "@brainstorm-agentic/core";

import type { WebFetchOptions } from "../web-search.js";
import {
  FsCache,
  LayeredCache,
  MemoryCache,
  type WebSearchCache,
} from "./cache.js";
import { EnginePool, type EngineRoute } from "./engines.js";
import { DEFAULT_PAPER_ROUTES, WebAccessManager, type WebAccessManagerOptions } from "./manager.js";
import {
  arxivProvider,
  braveProvider,
  crossrefProvider,
  openAlexProvider,
  searxngProvider,
  semanticScholarProvider,
  tavilyProvider,
  type ProviderFetch,
  type WebSearchProvider,
} from "./providers.js";
import {
  arxivBackend,
  crossrefBackend,
  openAlexBackend,
  semanticScholarBackend,
  type PaperBackend,
} from "./scholarly.js";
import { coreBackend, europePmcBackend, openCitationsBackend } from "./scholarly-extra.js";

export type GeneralSearchProviderId = "tavily" | "brave" | "searxng" | "none";

/** JSON-serializable web-search configuration (no secrets, ever). */
export interface WebSearchRuntimeConfig {
  /** The general/news provider; "none" (or absent) leaves those kinds off. */
  readonly general?: GeneralSearchProviderId;
  /** Base URL of the self-hosted SearXNG instance (general = "searxng"). */
  readonly searxngBaseUrl?: string;
  /** Scholarly chain on/off. Default ON — it needs no keys. */
  readonly scholarly?: boolean;
  /** Simultaneous upstream calls across all providers. Default 8. */
  readonly maxConcurrent?: number;
  /** Simultaneous calls to one provider. Default 4. */
  readonly maxPerProvider?: number;
  /** Keyword cache; off unless enabled. TTL default 24h. */
  readonly cache?: { readonly enabled: boolean; readonly ttlHours?: number };
  /** Polite-pool contact for OpenAlex/Crossref (recommended, not secret). */
  readonly contactEmail?: string;
  /**
   * "host" (default): the host web layer serves every web tool. "agent": the
   * deployment handed search to the agents' own built-in tools, and no
   * manager is built.
   */
  readonly mode?: "host" | "agent";
  /** The paid Brave Search API as the last resort on every route (needs its key). */
  readonly braveFallback?: {
    readonly enabled: boolean;
    /** Brave requests one run may make. Default 300. */
    readonly maxRequestsPerRun?: number;
    /** What the month's allowance still permits, computed by the server at submission. */
    readonly remainingThisMonth?: number;
  };
  /** The order of the provider lists: "searxng-first" (default) or "api-first". */
  readonly routePreset?: "searxng-first" | "api-first";
  /** Explicit provider lists per route; overrides the preset route by route. */
  readonly routes?: Partial<Record<WebSearchRoute, readonly string[]>>;
  /**
   * SearXNG engine scheduling. Set by the server for the app-launched
   * instance, whose enabled engines it renders; a self-hosted instance's
   * engines are unknown, so it gets no engine pool unless listed here.
   */
  readonly searxngEngines?: {
    readonly byRoute: Partial<Record<EngineRoute, readonly string[]>>;
    readonly perMinute?: number;
    readonly burst?: number;
    readonly maxWaitSeconds?: number;
    readonly dailyCap?: number;
  };
  /** Searches one task may make (a runaway guard); absent = unlimited. */
  readonly maxSearchesPerTask?: number;
}

/**
 * The engines the app-launched SearXNG enables, per route, in preference
 * order before the launch check ranks them. The launcher renders exactly
 * the union of these into the instance's settings, so every name the
 * coordinator sends exists there (an unknown name would make SearXNG fall
 * back to every engine of a category).
 */
export const LOCAL_SEARXNG_ENGINES: Readonly<Record<EngineRoute, readonly string[]>> = {
  web: ["google", "yahoo", "startpage", "mojeek", "duckduckgo", "brave", "qwant", "bing"],
  news: ["bing news", "yahoo news", "duckduckgo news", "google news", "wikinews"],
  "paper-lookup": ["yahoo", "google", "startpage", "mojeek"],
  "paper-topic": ["google", "yahoo", "startpage", "mojeek"],
  // arXiv is served by the direct, paced arXiv index: SearXNG's arXiv
  // engine would spend the same per-address allowance unpaced.
  "paper-science": ["europepmc"],
  "paper-details": [],
};

/** Every engine name in LOCAL_SEARXNG_ENGINES, once. */
export function localSearxngEngineNames(): readonly string[] {
  return [...new Set(Object.values(LOCAL_SEARXNG_ENGINES).flat())];
}

/**
 * The provider list per route for a preset. `primary` is the deployment's
 * general provider (or undefined); "brave" appears last as the paid
 * fallback, or first under "api-first". Entries with nothing configured
 * behind them are skipped at search time.
 */
export function presetRoutes(
  preset: "searxng-first" | "api-first",
  primary: string | undefined,
): Record<WebSearchRoute, readonly string[]> {
  const web = [...new Set([...(primary !== undefined ? [primary] : []), "brave"])];
  if (preset === "api-first") {
    const apiFirst = [...new Set(["brave", ...(primary !== undefined ? [primary] : [])])];
    return {
      web: apiFirst,
      news: apiFirst,
      "paper-lookup": ["openalex", "crossref", "semantic-scholar", "arxiv", "brave", "searxng"],
      "paper-topic": ["openalex", "semantic-scholar", "brave", "searxng", "searxng:science"],
      "paper-details": DEFAULT_PAPER_ROUTES["paper-details"],
    };
  }
  return {
    web,
    news: web,
    "paper-lookup": DEFAULT_PAPER_ROUTES["paper-lookup"],
    "paper-topic": DEFAULT_PAPER_ROUTES["paper-topic"],
    "paper-details": DEFAULT_PAPER_ROUTES["paper-details"],
  };
}

/** Provider secrets, delivered outside the JSON config. */
export interface WebSearchSecrets {
  readonly tavilyApiKey?: string;
  readonly braveApiKey?: string;
  readonly semanticScholarApiKey?: string;
  readonly openAlexApiKey?: string;
  /** CORE (core.ac.uk) API key, for the literature retrieval's CORE source. */
  readonly coreApiKey?: string;
}

export interface BuildWebAccessManagerOptions {
  readonly config: WebSearchRuntimeConfig;
  readonly secrets?: WebSearchSecrets;
  readonly log?: WebAccessManagerOptions["log"];
  /** Directory for the disk cache layer, when the cache is enabled. */
  readonly cacheDir?: string;
  readonly fetchOptions?: WebFetchOptions;
  /** Test seam: injected into every provider. */
  readonly fetchImpl?: ProviderFetch;
  /** Requests metered providers already made in this run (a resume). */
  readonly spent?: Readonly<Record<string, number>>;
  /** Called once per billed request (the host's local usage ledger). */
  readonly onSpend?: WebAccessManagerOptions["onSpend"];
  /** Source statuses known before the run (the availability table); see WebAccessManagerOptions. */
  readonly seededStatuses?: WebAccessManagerOptions["seededStatuses"];
  /** Fired on every status change of the run's web layer. */
  readonly onStatusChange?: WebAccessManagerOptions["onStatusChange"];
  /** The derived effective order per route; a named route replaces the configured list. */
  readonly routeOrders?: WebAccessManagerOptions["routeOrders"];
}

/**
 * The general provider this config + secrets can actually construct, or
 * undefined with the reason a readiness probe can show.
 */
export function resolveGeneralProvider(
  config: WebSearchRuntimeConfig,
  secrets: WebSearchSecrets = {},
  fetchImpl?: ProviderFetch,
): { provider: WebSearchProvider } | { missing: string } | undefined {
  const selected = config.general ?? "none";
  if (selected === "none") return undefined;
  if (selected === "tavily") {
    return secrets.tavilyApiKey !== undefined && secrets.tavilyApiKey !== ""
      ? {
          provider: tavilyProvider({
            apiKey: secrets.tavilyApiKey,
            ...(fetchImpl !== undefined ? { fetchImpl } : {}),
          }),
        }
      : { missing: "tavily is selected but no Tavily API key is configured" };
  }
  if (selected === "brave") {
    return secrets.braveApiKey !== undefined && secrets.braveApiKey !== ""
      ? {
          provider: braveProvider({
            apiKey: secrets.braveApiKey,
            ...(fetchImpl !== undefined ? { fetchImpl } : {}),
          }),
        }
      : { missing: "brave is selected but no Brave Search API key is configured" };
  }
  return config.searxngBaseUrl !== undefined && config.searxngBaseUrl.trim() !== ""
    ? {
        provider: searxngProvider({
          baseUrl: config.searxngBaseUrl,
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        }),
      }
    : { missing: "searxng is selected but no SearXNG base URL is configured" };
}

/**
 * Builds the run's one manager, or undefined when NOTHING is configured to
 * back a search (no general provider and scholarly switched off) — the
 * wiring then leaves the web_search tool unregistered and the broker reports
 * the capability honestly.
 */
export function buildWebAccessManager(
  options: BuildWebAccessManagerOptions,
): WebAccessManager | undefined {
  const { config } = options;
  // Search handed to the agents' own tools: no host layer at all.
  if (config.mode === "agent") return undefined;
  const secrets = options.secrets ?? {};
  const providers: WebSearchProvider[] = [];
  const chains: Partial<Record<WebSearchKind, string[]>> = {};

  const general = resolveGeneralProvider(config, secrets, options.fetchImpl);
  if (general !== undefined && "provider" in general) {
    providers.push(general.provider);
    chains.general = [general.provider.id];
    chains.news = [general.provider.id];
  }

  // The paid Brave Search API as the last resort, with its own key, unless
  // Brave already is the primary provider.
  const braveKey =
    secrets.braveApiKey !== undefined && secrets.braveApiKey !== "" ? secrets.braveApiKey : undefined;
  const braveFallback =
    config.braveFallback?.enabled === true &&
    braveKey !== undefined &&
    !providers.some((provider) => provider.id === "brave");
  if (braveFallback) {
    providers.push(
      braveProvider({
        apiKey: braveKey!,
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
  }

  const paperBackends: PaperBackend[] = [];
  if (config.scholarly !== false) {
    const contact =
      config.contactEmail !== undefined && config.contactEmail.trim() !== ""
        ? config.contactEmail.trim()
        : undefined;
    const scholarly: WebSearchProvider[] = [
      openAlexProvider({
        ...(secrets.openAlexApiKey !== undefined && secrets.openAlexApiKey !== ""
          ? { apiKey: secrets.openAlexApiKey }
          : {}),
        ...(contact !== undefined ? { contactEmail: contact } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      crossrefProvider({
        ...(contact !== undefined ? { contactEmail: contact } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      arxivProvider({
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      semanticScholarProvider({
        ...(secrets.semanticScholarApiKey !== undefined && secrets.semanticScholarApiKey !== ""
          ? { apiKey: secrets.semanticScholarApiKey }
          : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
    ];
    providers.push(...scholarly);
    chains.scholarly = scholarly.map((provider) => provider.id);
    // The same four indexes, with every paper option mapped (paper_search,
    // paper_details). They share the providers' pacing gates by id.
    paperBackends.push(
      openAlexBackend({
        ...(secrets.openAlexApiKey !== undefined && secrets.openAlexApiKey !== ""
          ? { apiKey: secrets.openAlexApiKey }
          : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      crossrefBackend({
        ...(contact !== undefined ? { contactEmail: contact } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      arxivBackend({
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      semanticScholarBackend({
        ...(secrets.semanticScholarApiKey !== undefined && secrets.semanticScholarApiKey !== ""
          ? { apiKey: secrets.semanticScholarApiKey }
          : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      // Literature-retrieval sources: no default route lists them, so the
      // agents' paper tools behave as before; the panel-composition stage
      // names them per call. Each has a known-answer probe for the launch
      // check and the availability service.
      europePmcBackend({
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      coreBackend({
        ...(secrets.coreApiKey !== undefined && secrets.coreApiKey !== "" ? { apiKey: secrets.coreApiKey } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
      openCitationsBackend({
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
  }

  if (providers.length === 0) return undefined;

  const primary = general !== undefined && "provider" in general ? general.provider.id : undefined;
  const preset = presetRoutes(config.routePreset ?? "searxng-first", primary);
  const routes: Partial<Record<WebSearchRoute, readonly string[]>> = {
    ...preset,
    ...(config.routes ?? {}),
  };

  const searxng = providers.find((provider) => provider.id === "searxng");
  const engines =
    searxng !== undefined && config.searxngEngines !== undefined
      ? new EnginePool({
          byRoute: config.searxngEngines.byRoute,
          ...(config.searxngEngines.perMinute !== undefined ? { perMinute: config.searxngEngines.perMinute } : {}),
          ...(config.searxngEngines.burst !== undefined ? { burst: config.searxngEngines.burst } : {}),
          ...(config.searxngEngines.maxWaitSeconds !== undefined
            ? { maxWaitMs: config.searxngEngines.maxWaitSeconds * 1000 }
            : {}),
          ...(config.searxngEngines.dailyCap !== undefined ? { dailyCap: config.searxngEngines.dailyCap } : {}),
        })
      : undefined;

  const budgets: Record<string, number> = {};
  if (braveFallback) {
    const perRun = Math.max(0, Math.trunc(config.braveFallback?.maxRequestsPerRun ?? 300));
    const month = config.braveFallback?.remainingThisMonth;
    budgets.brave = month !== undefined ? Math.max(0, Math.min(perRun, Math.trunc(month))) : perRun;
  }

  let cache: WebSearchCache | undefined;
  const routeCaches: Partial<Record<WebSearchRoute, WebSearchCache>> = {};
  let paperCache: WebSearchCache<PaperSearchAnswer> | undefined;
  let detailsCache: WebSearchCache<PaperDetailsAnswer> | undefined;
  if (config.cache?.enabled === true) {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const layered = <T,>(ttlMs: number, subdir?: string): WebSearchCache<T> => {
      const memory = new MemoryCache<T>(ttlMs);
      if (options.cacheDir === undefined) return memory;
      const dir = subdir === undefined ? options.cacheDir : `${options.cacheDir}/${subdir}`;
      return new LayeredCache<T>(memory, new FsCache<T>(dir, ttlMs));
    };
    // Web keeps the configured lifetime and the original directory, so a
    // plain question's existing cross-run entries still hit.
    const ttlMs = Math.max(1, config.cache.ttlHours ?? 24) * hour;
    cache = layered<WebSearchAnswer>(ttlMs);
    routeCaches.news = layered<WebSearchAnswer>(Math.min(ttlMs, hour), "news");
    const lookup = layered<PaperSearchAnswer>(30 * day, "paper-lookup");
    const topic = layered<PaperSearchAnswer>(7 * day, "paper-topic");
    paperCache = {
      get: (key) => (key.startsWith('["papers","paper-lookup"') ? lookup : topic).get(key),
      put: (key, answer) => (key.startsWith('["papers","paper-lookup"') ? lookup : topic).put(key, answer),
    };
    detailsCache = layered<PaperDetailsAnswer>(30 * day, "paper-details");
  }

  return new WebAccessManager({
    providers,
    chains,
    routes,
    paperBackends,
    ...(engines !== undefined ? { engines } : {}),
    budgets,
    ...(options.spent !== undefined ? { spent: options.spent } : {}),
    ...(options.onSpend !== undefined ? { onSpend: options.onSpend } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(config.maxConcurrent !== undefined ? { maxConcurrent: config.maxConcurrent } : {}),
    ...(config.maxPerProvider !== undefined ? { maxPerProvider: config.maxPerProvider } : {}),
    ...(cache !== undefined ? { cache } : {}),
    routeCaches,
    ...(paperCache !== undefined ? { paperCache } : {}),
    ...(detailsCache !== undefined ? { detailsCache } : {}),
    ...(config.maxSearchesPerTask !== undefined ? { maxSearchesPerTask: config.maxSearchesPerTask } : {}),
    ...(options.fetchOptions !== undefined ? { fetchOptions: options.fetchOptions } : {}),
    ...(options.seededStatuses !== undefined ? { seededStatuses: options.seededStatuses } : {}),
    ...(options.onStatusChange !== undefined ? { onStatusChange: options.onStatusChange } : {}),
    ...(options.routeOrders !== undefined ? { routeOrders: options.routeOrders } : {}),
  });
}
