import { createHash } from "node:crypto";
import { importRuntimeComponent } from "@brainstorm-agentic/core";
import { join } from "node:path";
import type { ClaudeAgentEffort, CursorModelCatalogEntry, LlmSettings, ModelCapabilities, ModelCatalogSnapshot, ModelOption, ServerSettings, StageModelSettings, StageOption } from "@brainstorm-agentic/protocol";
import { discoverGeminiModels, type GeminiDiscoveredModel } from "@brainstorm-agentic/provider-gemini";
import { listCursorModels } from "@brainstorm-agentic/executor-cursor-agent";
import { normalizeClaudeSetupToken } from "@brainstorm-agentic/executor-claude-agent";
import { atomicWriteFile, readJsonFile } from "./files.js";
import { loadModelCatalog } from "./route-catalog.js";

const EFFORTS: readonly ClaudeAgentEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;
const normalized = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface DiscoveryContext { readonly provider: LlmSettings["provider"]; readonly secret?: string; readonly baseUrl?: string }
export interface DiscoveredModels { readonly models: readonly ModelOption[]; readonly cursorModels?: readonly CursorModelCatalogEntry[] }
export type ModelDiscoverer = (context: DiscoveryContext, signal: AbortSignal) => Promise<DiscoveredModels>;

export function cursorModelOption(entry: CursorModelCatalogEntry): ModelOption {
  const parameters = entry.parameters;
  if (parameters === undefined) return { id: entry.id, label: entry.displayName ?? entry.id, ...(entry.aliases ? { aliases: entry.aliases } : {}) };
  const thinking = parameters.find((p) => normalized(`${p.id} ${p.displayName ?? ""}`).includes("thinking"));
  const effort = parameters.find((p) => p !== thinking && /effort|reasoning/.test(normalized(`${p.id} ${p.displayName ?? ""}`)));
  const effortValues = new Set(effort?.values.map((v) => normalized(v.value)) ?? []);
  const aliases: Record<ClaudeAgentEffort, readonly string[]> = { minimal: ["minimal"], low: ["low"], medium: ["medium", "standard", "default"], high: ["high"], xhigh: ["xhigh", "extrahigh", "veryhigh"], max: ["max", "maximum"] };
  const thinkingValues = new Set((thinking ?? effort)?.values.map((v) => normalized(v.value)) ?? []);
  const off = ["off", "disabled", "none", "no", "false"].some((v) => thinkingValues.has(v));
  const adaptive = thinking !== undefined && ["adaptive", "auto", "on", "enabled", "true", "thinking"].some((v) => thinkingValues.has(v));
  return { id: entry.id, label: entry.displayName ?? entry.id, ...(entry.aliases ? { aliases: entry.aliases } : {}), capabilities: {
    effortLevels: EFFORTS.filter((level) => aliases[level].some((v) => effortValues.has(v))),
    adaptiveThinking: adaptive,
    thinkingCanBeDisabled: off,
  } };
}

export function claudeModelOptions(raw: readonly unknown[]): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const value of raw) {
    const row = object(value);
    const id = text(row.value);
    if (!id) continue;
    const resolved = text(row.resolvedModel);
    const rawLevels = row.supportedEffortLevels;
    const levels = row.supportsEffort === false ? [] : Array.isArray(rawLevels) ? EFFORTS.filter((e) => rawLevels.includes(e)) : undefined;
    // A partial SDK response must not erase an explicit restriction when API
    // metadata is merged later. Keep unreported controls unavailable here.
    const restricted = row.supportsEffort === false || row.supportsAdaptiveThinking === false || row.supportsThinkingDisabled === false;
    const capabilities = (levels !== undefined && typeof row.supportsAdaptiveThinking === "boolean") || restricted ? {
      effortLevels: levels ?? [], adaptiveThinking: row.supportsAdaptiveThinking === true,
      ...(typeof row.supportsThinkingDisabled === "boolean" ? { thinkingCanBeDisabled: row.supportsThinkingDisabled } : {}),
    } : undefined;
    const option: ModelOption = { id, label: text(row.displayName) ?? id, ...(resolved && resolved !== id ? { aliases: [resolved] } : {}), ...(capabilities ? { capabilities } : {}) };
    models.set(id, option);
    if (resolved && resolved !== id) models.set(resolved, { ...option, id: resolved, label: `${option.label} (${resolved})`, aliases: [id] });
  }
  return [...models.values()];
}

export function anthropicModelOption(value: unknown): ModelOption | undefined {
  const row = object(value); const id = text(row.id);
  if (!id) return undefined;
  const caps = object(row.capabilities); const effort = object(caps.effort); const thinking = object(caps.thinking);
  const types = object(thinking.types); const adaptive = object(types.adaptive).supported; const disabled = object(types.disabled).supported;
  const capabilities: ModelCapabilities | undefined = typeof effort.supported === "boolean" && typeof adaptive === "boolean" ? {
    effortLevels: effort.supported ? EFFORTS.filter((level) => object(effort[level]).supported === true) : [],
    adaptiveThinking: adaptive,
    ...(typeof disabled === "boolean" ? { thinkingCanBeDisabled: disabled } : {}),
  } : undefined;
  return { id, label: text(row.display_name) ?? id, ...(capabilities ? { capabilities } : {}) };
}

/** SDK aliases and context-window variants share the canonical API capabilities. */
export function mergeClaudeModelOptions(sdkModels: readonly ModelOption[], apiModels: readonly ModelOption[]): ModelOption[] {
  const canonicalId = (id: string): string => id.replace(/\[\d+[mk]\]$/i, "");
  const models = new Map(apiModels.map((model) => [model.id, model]));
  for (const sdk of sdkModels) {
    const api = apiModels.find((model) => [sdk.id, ...(sdk.aliases ?? [])].some((id) => canonicalId(id) === model.id));
    const apiDisabled = api?.capabilities?.thinkingCanBeDisabled;
    const sdkDisabled = sdk.capabilities?.thinkingCanBeDisabled;
    const thinkingCanBeDisabled = apiDisabled === undefined ? sdkDisabled : sdkDisabled === undefined ? apiDisabled : apiDisabled && sdkDisabled;
    // Both layers must accept the chosen controls. The API also supplies the
    // disabled-thinking capability that older SDK metadata does not expose.
    const capabilities = api?.capabilities ? {
      ...api.capabilities,
      effortLevels: api.capabilities.effortLevels.filter((effort) => !sdk.capabilities || sdk.capabilities.effortLevels.includes(effort)),
      adaptiveThinking: api.capabilities.adaptiveThinking && (sdk.capabilities?.adaptiveThinking ?? true),
      ...(thinkingCanBeDisabled !== undefined ? { thinkingCanBeDisabled } : {}),
    } : sdk.capabilities;
    models.set(sdk.id, { ...sdk, label: api?.id === sdk.id ? api.label : sdk.label, ...(capabilities ? { capabilities } : {}) });
  }
  return [...models.values()];
}

async function anthropicModels(context: DiscoveryContext, signal: AbortSignal, oauth = false): Promise<ModelOption[]> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    ...(oauth ? { apiKey: null, authToken: normalizeClaudeSetupToken(context.secret!), defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } }
      : { apiKey: context.secret, ...(context.baseUrl ? { baseURL: context.baseUrl } : {}) }),
    maxRetries: 0,
  });
  const models: ModelOption[] = [];
  // Async iteration follows every pagination cursor without generating a response.
  for await (const raw of client.models.list({ limit: 100 }, { signal })) {
    const model = anthropicModelOption(raw); if (model) models.push(model);
  }
  return models;
}

export function geminiModelOption(row: GeminiDiscoveredModel): ModelOption {
  return { id: row.id, label: row.displayName ?? row.id,
    ...(row.profile ? { capabilities: {
      effortLevels: EFFORTS.filter((level) => row.profile!.thinkingLevels.some((native) => native === level)),
      adaptiveThinking: false,
      ...(row.profile.thinkingBudget?.canDisable === true ? { thinkingCanBeDisabled: true } : {}),
    } } : {}) };
}

export const discoverProviderModels: ModelDiscoverer = async (context, signal) => {
  if (context.provider === "offline") return { models: [] };
  if (!context.secret) throw new Error("Provider is not connected");
  if (context.provider === "cursor-agent") {
    const cursorModels = await listCursorModels(context.secret);
    return { models: cursorModels.map(cursorModelOption), cursorModels };
  }
  if (context.provider === "gemini") {
    const rows = await discoverGeminiModels({ apiKey: context.secret, signal, ...(context.baseUrl ? { baseURL: context.baseUrl } : {}) });
    return { models: rows.map(geminiModelOption) };
  }
  if (context.provider === "anthropic") {
    return { models: await anthropicModels(context, signal) };
  }
  const [sdk, api] = await Promise.allSettled([claudeSdkModels(context.secret, signal), anthropicModels(context, signal, true)]);
  if (sdk.status === "rejected" && api.status === "rejected") throw new Error("Provider model discovery failed");
  return { models: mergeClaudeModelOptions(sdk.status === "fulfilled" ? sdk.value : [], api.status === "fulfilled" ? api.value : []) };
};

async function claudeSdkModels(secret: string, signal: AbortSignal): Promise<ModelOption[]> {
  const { query } = await importRuntimeComponent("claude", "@anthropic-ai/claude-agent-sdk", import.meta.url,
    () => import("@anthropic-ai/claude-agent-sdk"));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  // Keep input open for initialization, but never submit a user message or buy a model turn.
  async function* emptyPrompt() { await hold; }
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: normalizeClaudeSetupToken(secret) };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const session = query({ prompt: emptyPrompt(), options: { abortController: controller, env, tools: [], settingSources: [], persistSession: false, permissionMode: "dontAsk" } });
  try { return claudeModelOptions(await session.supportedModels()); }
  finally { signal.removeEventListener("abort", abort); session.close(); release(); controller.abort(); }
}

/** Schema-check provider/disk data before exposing it to the UI or worker. */
export function sanitizeModels(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const row = object(raw); const id = text(row.id); const label = text(row.label);
    if (!id || !label) return [];
    const cap = object(row.capabilities);
    const capabilities: ModelCapabilities | undefined = Array.isArray(cap.effortLevels) && cap.effortLevels.every((v) => EFFORTS.includes(v)) && typeof cap.adaptiveThinking === "boolean" ? {
      effortLevels: [...new Set(cap.effortLevels as ClaudeAgentEffort[])], adaptiveThinking: cap.adaptiveThinking,
      ...(typeof cap.thinkingCanBeDisabled === "boolean" ? { thinkingCanBeDisabled: cap.thinkingCanBeDisabled } : {}),
    } : undefined;
    return [{ id, label, ...(Array.isArray(row.aliases) && row.aliases.every((a) => typeof a === "string") ? { aliases: row.aliases as string[] } : {}), ...(capabilities ? { capabilities } : {}) }];
  });
}

function sanitizeCursorModels(value: unknown): CursorModelCatalogEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((raw) => {
    const row = object(raw); const id = text(row.id); if (!id) return [];
    const parameters = Array.isArray(row.parameters) ? row.parameters.flatMap((rawParameter) => {
      const p = object(rawParameter); const id = text(p.id); if (!id || !Array.isArray(p.values)) return [];
      return [{ id, ...(text(p.displayName) ? { displayName: text(p.displayName) } : {}), ...(text(p.defaultValue) ? { defaultValue: text(p.defaultValue) } : {}),
        values: p.values.flatMap((rawValue) => { const v = object(rawValue); return typeof v.value === "string" ? [{ value: v.value, ...(text(v.displayName) ? { displayName: text(v.displayName) } : {}) }] : []; }) }];
    }) : undefined;
    return [{ id, ...(text(row.displayName) ? { displayName: text(row.displayName) } : {}),
      ...(Array.isArray(row.aliases) && row.aliases.every((a) => typeof a === "string") ? { aliases: row.aliases as string[] } : {}), ...(parameters ? { parameters } : {}) }];
  });
}

/** Component acquisition has its own bounded download; provider discovery keeps its short deadline. */
export async function prepareProviderRuntime(context: DiscoveryContext): Promise<void> {
  if (!context.secret) return;
  if (context.provider === "claude-agent") await importRuntimeComponent("claude", "@anthropic-ai/claude-agent-sdk", import.meta.url,
    () => import("@anthropic-ai/claude-agent-sdk"));
  else if (context.provider === "cursor-agent") await importRuntimeComponent("cursor", "@cursor/sdk", import.meta.url);
}

export class ModelDiscovery {
  private readonly cache = new Map<string, ModelCatalogSnapshot>();
  private readonly pending = new Map<string, Promise<ModelCatalogSnapshot>>();
  private readonly path: string;
  constructor(private readonly workspace: string, private readonly discover: ModelDiscoverer = discoverProviderModels, private readonly timeoutMs = 15_000,
    private readonly prepare: ((context: DiscoveryContext) => Promise<void>) | undefined = discover === discoverProviderModels ? prepareProviderRuntime : undefined) {
    this.path = join(workspace, "model-options-cache.json");
    try {
      const disk = object(readJsonFile<unknown>(this.path));
      if (disk.schemaVersion !== 1) return;
      for (const [key, raw] of Object.entries(object(disk.entries))) {
        const row = object(raw);
        if (!/^[a-f0-9]{64}$/.test(key) || !["anthropic", "claude-agent", "cursor-agent", "gemini", "offline"].includes(String(row.provider)) || typeof row.fetchedAt !== "number" || !Number.isFinite(row.fetchedAt)) continue;
        const models = sanitizeModels(row.models); if (models.length === 0 && row.provider !== "offline") continue;
        this.cache.set(key, { provider: row.provider as LlmSettings["provider"], fetchedAt: row.fetchedAt, source: "provider", stale: true, models,
          ...(row.provider === "cursor-agent" ? { cursorModels: sanitizeCursorModels(row.cursorModels) } : {}) });
      }
    } catch { /* Missing/corrupt cache falls back to unverified deployment options. */ }
  }
  key(context: DiscoveryContext): string { return createHash("sha256").update(JSON.stringify([context.provider, context.baseUrl ?? "", context.secret ?? ""])).digest("hex"); }
  read(context: DiscoveryContext): ModelCatalogSnapshot {
    return structuredClone(this.cache.get(this.key(context)) ?? { provider: context.provider, fetchedAt: null, source: "fallback", stale: true,
      models: sanitizeModels(loadModelCatalog(this.workspace)[context.provider] ?? []).map(({ capabilities: _unknown, ...option }) => option), error: "Model capabilities have not been discovered for this connection." });
  }
  async refresh(context: DiscoveryContext): Promise<ModelCatalogSnapshot> {
    const key = this.key(context); const existing = this.pending.get(key); if (existing) return existing;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      try {
        if (this.prepare) await this.prepare(context);
        const discovered = await Promise.race([this.discover(context, controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("discovery timeout")); }, this.timeoutMs);
        })]);
        const models = sanitizeModels(discovered.models);
        if (models.length === 0 && context.provider !== "offline") throw new Error("empty catalog");
        const snapshot: ModelCatalogSnapshot = { provider: context.provider, fetchedAt: Date.now(), source: "provider", stale: false, models,
          ...(context.provider === "cursor-agent" ? { cursorModels: sanitizeCursorModels(discovered.cursorModels) } : {}) };
        this.cache.set(key, snapshot);
        try { atomicWriteFile(this.path, JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(this.cache) }), 0o600); } catch { /* In-memory discovery remains usable if cache persistence fails. */ }
        return structuredClone(snapshot);
      } catch {
        const stale = { ...this.read(context), stale: true, error: "Model discovery is unavailable. Cached options may be out of date." };
        this.cache.set(key, stale); return structuredClone(stale);
      } finally { if (timer) clearTimeout(timer); controller.abort(); }
    })();
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
}

export function validateStageCapabilities(settings: ServerSettings, stages: Readonly<Record<string, StageModelSettings>>, catalog: ModelCatalogSnapshot, options: readonly StageOption[]): void {
  for (const [id, selection] of Object.entries(stages)) {
    const stage = options.find((entry) => entry.id === id);
    // Settings from a newer bundle remain stored, but do not affect this workflow.
    if (!stage) continue;
    const modelId = selection.model ?? (stage.route ? settings.llm.modelsByRoute?.[stage.route] : undefined)
      ?? settings.llm.model ?? settings.llm.modelsByRoute?.reasoning ?? (settings.llm.provider === "cursor-agent" ? "auto" : undefined);
    const model = catalog.models.find((entry) => entry.id === modelId || entry.aliases?.includes(modelId ?? ""));
    if (selection.model && !model) throw new Error(`${stage.label}: model ${selection.model} is not available for this provider. Select a model from the current catalog.`);
    if (selection.effort && !model?.capabilities?.effortLevels.includes(selection.effort)) throw new Error(`${stage.label}: ${modelId ?? "the default model"} does not advertise ${selection.effort} effort. Choose a supported effort or inherit the default.`);
    if (selection.thinking === "adaptive" && model?.capabilities?.adaptiveThinking !== true) throw new Error(`${stage.label}: ${modelId ?? "the default model"} does not advertise adaptive thinking. Choose a supported model or inherit the default.`);
    if (selection.thinking === "disabled" && model?.capabilities?.thinkingCanBeDisabled !== true) throw new Error(`${stage.label}: ${modelId ?? "the default model"} does not advertise disabling thinking. Choose a supported model or inherit the default.`);
  }
}
