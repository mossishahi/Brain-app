/**
 * Read-only helpers behind GET /api/model-options: the task types (logical
 * routes) declared by the pinned content bundle, and the per-provider model
 * dictionary offered by the per-task-type picker.
 */
import { join } from "node:path";

import {
  DEFAULT_MODEL_CATALOG,
  type ProviderModelCatalog,
  type TaskTypeOption,
} from "@brainstorm-agentic/protocol";
import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";

import { readJsonFile } from "./files.js";

const CACHE_TTL_MS = 5 * 60_000;

/** Shown when the registry is unreachable and nothing is cached yet. */
const FALLBACK_TASK_TYPES: readonly TaskTypeOption[] = [
  {
    id: "reasoning",
    description: "Deep multi-step scientific reasoning steps.",
  },
  { id: "writing", description: "Long-form synthesis and writing steps." },
  { id: "balanced", description: "General-purpose auxiliary steps." },
];

interface CacheEntry {
  readonly at: number;
  readonly types: readonly TaskTypeOption[];
}

/**
 * Caches the pinned bundle's route catalog so the model picker never adds a
 * registry round-trip per request. Stale entries are served when the
 * registry is temporarily unreachable.
 */
export class RouteCatalog {
  readonly #cache = new Map<string, CacheEntry>();

  async taskTypes(
    registryUrl: string,
    bundle: string,
    version?: string,
  ): Promise<readonly TaskTypeOption[]> {
    const key = `${registryUrl}\u0000${bundle}\u0000${version ?? ""}`;
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.types;
    try {
      const client = new ContentRegistryClient(registryUrl);
      try {
        const pin = await client.resolvePin(bundle, version);
        const raw = JSON.parse(
          await client.readText(
            `bundles/${bundle}/${pin.version}/routes/model-routes.json`,
          ),
        ) as { readonly routes?: Record<string, { readonly description?: string }> };
        const types = Object.entries(raw.routes ?? {}).map(
          ([id, definition]): TaskTypeOption => ({
            id,
            description:
              typeof definition?.description === "string"
                ? definition.description
                : "",
          }),
        );
        if (types.length > 0) {
          this.#cache.set(key, { at: Date.now(), types });
          return types;
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch {
      // Fall through to the stale cache or the static fallback.
    }
    return hit?.types ?? FALLBACK_TASK_TYPES;
  }
}

/**
 * The per-provider model dictionary: shipped defaults, overridable per
 * deployment by a `model-catalog.json` file (same shape) in the workspace
 * root. Provider keys in the override replace the default entry wholesale.
 */
export function loadModelCatalog(workspace: string): ProviderModelCatalog {
  let override: ProviderModelCatalog | undefined;
  try {
    override = readJsonFile<ProviderModelCatalog>(
      join(workspace, "model-catalog.json"),
    );
  } catch {
    override = undefined;
  }
  if (typeof override !== "object" || override === null) {
    return DEFAULT_MODEL_CATALOG;
  }
  const merged: Record<
    string,
    ProviderModelCatalog[string]
  > = { ...DEFAULT_MODEL_CATALOG };
  for (const [provider, models] of Object.entries(override)) {
    if (!Array.isArray(models)) continue;
    merged[provider] = models.filter(
      (entry): entry is { id: string; label: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { label?: unknown }).label === "string",
    );
  }
  return merged;
}
