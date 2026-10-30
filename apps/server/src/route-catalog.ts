/**
 * Read-only helpers behind GET /api/model-options: the task types (logical
 * routes) declared by the pinned content bundle, and the per-provider model
 * dictionary offered by the per-task-type picker.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  DEFAULT_MODEL_CATALOG,
  type ProviderModelCatalog,
  type TaskTypeOption,
  type StageOption,
} from "@brainstorm-agentic/protocol";
import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";

import { atomicWriteFile, readJsonFile } from "./files.js";

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
  readonly stages: readonly StageOption[];
}

const CONTROL_STAGES: readonly StageOption[] = [
  { id: "fact-verification", label: "Fact verification", description: "Verify shared scientific facts.", route: "reasoning" },
  { id: "fact-consultation", label: "Fact consultation", description: "Consult shared facts while an agent works.", route: "reasoning" },
  { id: "fact-update", label: "Fact updates", description: "Reconsider work affected by updated facts.", route: "reasoning" },
];

const STAGE_PRESENTATION: Readonly<Record<string, readonly [string, string]>> = {
  "process-input": ["Prepare input", "Organize the submission and attached material for the research panel."],
  "classify-input": ["Classify input", "Identify the requested work and prepare terms for finding relevant research."],
  "annotate-code": ["Read attached code", "Identify what each attached code file contributes to the submission."],
  "screen-literature": ["Screen literature", "Select research papers relevant to the submission."],
  "develop-idea": ["Develop proposal", "Develop each panel member's initial analysis and proposed answer."],
  "game-comment-step-bridge": ["Cross-field review (scored)", "Review the reasoning from a perspective that connects research fields."],
  "game-comment-step": ["Peer review (scored)", "Assess the reasoning and support review comments with evidence."],
  "chair-step": ["Review chair", "Evaluate review arguments and decide which issues need revision."],
  "game-chair-reassess": ["Review chair reassessment", "Reassess review decisions after evidence or comments change."],
  "game-redevelop-idea": ["Revise proposal (scored)", "Revise the proposal to address confirmed review issues."],
  "comment-step-bridge": ["Cross-field review", "Review the reasoning from a perspective that connects research fields."],
  "comment-step": ["Peer review", "Assess the reasoning and support review comments with evidence."],
  "judge-step": ["Review judgement", "Decide which review comments identify issues that need revision."],
  "judge-reassess": ["Review reassessment", "Reconsider review decisions after comments change."],
  "redevelop-idea": ["Revise proposal", "Revise the proposal to address confirmed review issues."],
  "bridge-audit": ["Integration audit", "Check how the panel members' finished work fits together."],
  "synthesize-proposal": ["Final synthesis", "Combine the panel's work into the final response."],
};

export function workflowStages(workflow: unknown): StageOption[] {
  const stages = new Map<string, StageOption>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (node.kind === "agent" && typeof node.id === "string") {
      const presentation = STAGE_PRESENTATION[node.id];
      stages.set(node.id, { id: node.id, label: presentation?.[0] ?? node.id.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase()),
        description: presentation?.[1] ?? "Run this stage of the research workflow.",
        ...(typeof node.route === "string" ? { route: node.route } : {}) });
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(workflow);
  for (const stage of CONTROL_STAGES) stages.set(stage.id, stage);
  return [...stages.values()];
}

/**
 * Caches the pinned bundle's route catalog so the model picker never adds a
 * registry round-trip per request. Stale entries are served when the
 * registry is temporarily unreachable.
 */
export class RouteCatalog {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #path?: string;

  constructor(workspace?: string) {
    this.#path = workspace ? join(workspace, "workflow-model-stages.json") : undefined;
    if (!this.#path) return;
    try {
      const disk = readJsonFile<{ entries?: Record<string, CacheEntry> }>(this.#path);
      for (const [key, entry] of Object.entries(disk?.entries ?? {})) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(entry.at) || !Array.isArray(entry.types) || !Array.isArray(entry.stages)) continue;
        if (!entry.types.every((x) => typeof x.id === "string" && typeof x.description === "string") || !entry.stages.every((x) => typeof x.id === "string" && typeof x.label === "string" && typeof x.description === "string" && (x.route === undefined || typeof x.route === "string"))) continue;
        this.#cache.set(key, entry);
      }
    } catch { /* Discovery can rebuild an absent or corrupt cache. */ }
  }

  private key(registryUrl: string, bundle: string, version?: string): string {
    return createHash("sha256").update(JSON.stringify([registryUrl, bundle, version ?? ""])).digest("hex");
  }

  cachedTaskTypes(registryUrl: string, bundle: string, version?: string): readonly TaskTypeOption[] {
    return this.#cache.get(this.key(registryUrl, bundle, version))?.types ?? FALLBACK_TASK_TYPES;
  }

  cachedStages(registryUrl: string, bundle: string, version?: string): readonly StageOption[] {
    return this.#cache.get(this.key(registryUrl, bundle, version))?.stages ?? [];
  }

  async refresh(registryUrl: string, bundle: string, version?: string): Promise<void> {
    const key = this.key(registryUrl, bundle, version);
    const pending = this.#pending.get(key); if (pending) return pending;
    const work = this.fetch(registryUrl, bundle, version);
    this.#pending.set(key, work);
    try { await work; } finally { this.#pending.delete(key); }
  }

  async taskTypes(
    registryUrl: string,
    bundle: string,
    version?: string,
  ): Promise<readonly TaskTypeOption[]> {
    const key = this.key(registryUrl, bundle, version);
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.types;
    await this.refresh(registryUrl, bundle, version);
    return this.cachedTaskTypes(registryUrl, bundle, version);
  }

  private async fetch(registryUrl: string, bundle: string, version?: string): Promise<void> {
    const key = this.key(registryUrl, bundle, version);
    const client = new ContentRegistryClient(registryUrl);
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        void client.close().catch(() => undefined);
        reject(new Error("Workflow stage discovery timed out"));
      }, 15_000);
    });
    try {
      await Promise.race([(async () => {
        const pin = await client.resolvePin(bundle, version);
        const [routesText, workflowText] = await Promise.all([
          client.readText(
            `bundles/${bundle}/${pin.version}/routes/model-routes.json`,
          ),
          client.readText(`bundles/${bundle}/${pin.version}/${pin.manifest.entrypoints.workflow}`),
        ]);
        const raw = JSON.parse(routesText) as { readonly routes?: Record<string, { readonly description?: string }> };
        const types = Object.entries(raw.routes ?? {}).map(
          ([id, definition]): TaskTypeOption => ({
            id,
            description:
              typeof definition?.description === "string"
                ? definition.description
                : "",
          }),
        );
        if (!expired && types.length > 0) {
          this.#cache.set(key, { at: Date.now(), types, stages: workflowStages(JSON.parse(workflowText)) });
          if (this.#path) atomicWriteFile(this.#path, JSON.stringify({ entries: Object.fromEntries(this.#cache) }), 0o600);
        }
      })(), timeout]);
    } catch {
      // Fall through to the stale cache or the static fallback.
    } finally {
      if (timer) clearTimeout(timer);
      void client.close().catch(() => undefined);
    }
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
