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
 * - general/news: exactly the ONE provider the deployment selected (tavily,
 *   brave, or a self-hosted searxng). Unconfigured means the chain is empty
 *   and a general query gets an explicit configuration error naming the fix
 *   — never a silent degradation, and never a provider guessed at.
 */
import type { WebSearchKind } from "@brainstorm-agentic/core";

import type { WebFetchOptions } from "../web-search.js";
import {
  FsWebSearchCache,
  LayeredWebSearchCache,
  MemoryWebSearchCache,
  type WebSearchCache,
} from "./cache.js";
import { WebAccessManager, type WebAccessManagerOptions } from "./manager.js";
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
}

/** Provider secrets, delivered outside the JSON config. */
export interface WebSearchSecrets {
  readonly tavilyApiKey?: string;
  readonly braveApiKey?: string;
  readonly semanticScholarApiKey?: string;
  readonly openAlexApiKey?: string;
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
  const secrets = options.secrets ?? {};
  const providers: WebSearchProvider[] = [];
  const chains: Partial<Record<WebSearchKind, string[]>> = {};

  const general = resolveGeneralProvider(config, secrets, options.fetchImpl);
  if (general !== undefined && "provider" in general) {
    providers.push(general.provider);
    chains.general = [general.provider.id];
    chains.news = [general.provider.id];
  }

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
  }

  if (providers.length === 0) return undefined;

  let cache: WebSearchCache | undefined;
  if (config.cache?.enabled === true) {
    const ttlMs = Math.max(1, config.cache.ttlHours ?? 24) * 60 * 60 * 1000;
    const memory = new MemoryWebSearchCache(ttlMs);
    cache =
      options.cacheDir !== undefined
        ? new LayeredWebSearchCache(memory, new FsWebSearchCache(options.cacheDir, ttlMs))
        : memory;
  }

  return new WebAccessManager({
    providers,
    chains,
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(config.maxConcurrent !== undefined ? { maxConcurrent: config.maxConcurrent } : {}),
    ...(config.maxPerProvider !== undefined ? { maxPerProvider: config.maxPerProvider } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(options.fetchOptions !== undefined ? { fetchOptions: options.fetchOptions } : {}),
  });
}
