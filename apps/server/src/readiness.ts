/**
 * Environment readiness: the server-side checks behind the webapp's status
 * icons (LLM, internet, code workspace, SLURM — next to the Brain Registry
 * indicator), the submission gate, and the LLM-guided fix advice.
 *
 * Checks are deployment probes, not pipeline content: they verify that THIS
 * host — often an HPC login or compute node — can actually reach the model
 * API, reach the internet, run scripts in a scratch workspace, and submit
 * SLURM jobs that really execute. Results persist in the workspace so a
 * relaunch on another node of the same cluster shows the last known state
 * immediately and re-verifies in the background.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  nativeOffersFor,
  resolveCapabilityPlan,
  type CapabilityDeclaration,
} from "@brainstorm-agentic/core";
import {
  ATTACHMENT_MANIFESTS,
  FACT_MANIFESTS,
  NOTES_MANIFESTS,
  TAXONOMY_MANIFESTS,
  WEB_SEARCH_MANIFESTS,
  prepareCodeWorkspace,
  slurmClusterArgs,
  stripSlurmClusterBanners,
} from "@brainstorm-agentic/host-tools";
import {
  READINESS_CHECK_IDS,
  type ReadinessCheck,
  type ReadinessCheckId,
  type ReadinessCheckState,
  type ReadinessReport,
  type ServerSettings,
} from "@brainstorm-agentic/protocol";

import { renderSlurmTemplate, shellQuote } from "./command.js";
import { atomicWriteJson, readJsonFile } from "./files.js";
import { slurmSubmissionDiagnostic, slurmSubmissionReceipt } from "./slurm-submission.js";
import { searxngDir, searxngLocalUrl } from "./searxng-launcher.js";
import {
  validateGeminiConnection,
  localWebSearchIssue,
  localWebSearchUnavailable,
  paidWebSearchFallbackAvailable,
} from "./settings.js";
import type { ContentRegistryRuntimeStatus } from "./model.js";
import { BUILTIN_ENCODER_ID, LOCAL_ENCODER_IDS } from "./panel-composition.js";
import type {
  AnthropicConnectionValidator,
  ClaudeAgentConnectionValidator,
  CursorAgentConnectionValidator,
  GeminiConnectionValidator,
  SettingsStore,
} from "./settings.js";

export const READINESS_CHECK_LABELS: Readonly<Record<ReadinessCheckId, string>> = {
  registry: "Brain Registry",
  llm: "Model connection",
  capabilities: "Agent capabilities",
  internet: "Internet access",
  code: "Code workspace",
  slurm: "SLURM scheduler",
};

const LOCAL_SEARCH_ADVICE =
  "Wait for local SearXNG to become ready; if it failed, inspect the SearXNG server log and retry the service.";

/** One text encoder's availability on this host (spec v2 Section 9; contract G). */
export interface EncoderAvailability {
  readonly id: string;
  readonly available: boolean;
  readonly detail: string;
}

/** Response of GET /api/readiness/encoders. */
export interface EncoderReadiness {
  /** BRAINSTORM_AGENTIC_ENCODER_DIR as this server sees it. */
  readonly modelDir?: string;
  /** The encoder new runs ask for: the panel-composition override, else the spec default. */
  readonly selected: string;
  readonly selectedAvailable: boolean;
  /** What a run uses (and records) when the selected encoder is unavailable. */
  readonly fallback: string;
  readonly encoders: readonly EncoderAvailability[];
}

/** The files a local encoder export needs (contract G); specter2 adds query.onnx. */
const ENCODER_MODEL_FILES = ["doc.onnx", "tokenizer.json", "tokenizer_config.json", "manifest.json"];

/**
 * Which encoders a run could use: the local ONNX exports present under
 * BRAINSTORM_AGENTIC_ENCODER_DIR, the built-in hash-ngram fallback, and
 * openrouter:<model> when an OpenRouter key is configured. Informational: an
 * unavailable encoder never holds submissions, because a run falls back to
 * hash-ngram-v1 and records it.
 */
export function encoderReadiness(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly openRouterKeyConfigured: boolean;
  readonly selected?: string;
}): EncoderReadiness {
  const raw = input.env.BRAINSTORM_AGENTIC_ENCODER_DIR?.trim();
  const modelDir = raw !== undefined && raw !== "" ? raw : undefined;
  const encoders: EncoderAvailability[] = LOCAL_ENCODER_IDS.map((id): EncoderAvailability => {
    if (modelDir === undefined) {
      return { id, available: false, detail: "BRAINSTORM_AGENTIC_ENCODER_DIR is not set" };
    }
    const files = [...ENCODER_MODEL_FILES, ...(id === "specter2" ? ["query.onnx"] : [])];
    const missing = files.filter((file) => !existsSync(join(modelDir, id, file)));
    return missing.length === 0
      ? { id, available: true, detail: join(modelDir, id) }
      : { id, available: false, detail: `missing ${missing.join(", ")} under ${join(modelDir, id)}` };
  });
  encoders.push({
    id: BUILTIN_ENCODER_ID,
    available: true,
    detail: "built-in dependency-free fallback",
  });
  const selected = input.selected ?? "specter2";
  encoders.push({
    id: selected.startsWith("openrouter:") ? selected : "openrouter:<model>",
    available: input.openRouterKeyConfigured,
    detail: input.openRouterKeyConfigured
      ? "OpenRouter embeddings API (key configured)"
      : "needs the OpenRouter API key (Recovery settings)",
  });
  return {
    ...(modelDir !== undefined ? { modelDir } : {}),
    selected,
    selectedAvailable: encoders.find((encoder) => encoder.id === selected)?.available ?? false,
    fallback: BUILTIN_ENCODER_ID,
    encoders,
  };
}

/** Whether a check matters under the current settings (hidden otherwise). */
export function readinessCheckRequired(
  id: ReadinessCheckId,
  settings: ServerSettings,
): boolean {
  switch (id) {
    case "registry":
    case "code":
      return true;
    case "llm":
    case "internet":
      return settings.llm.provider !== "offline";
    case "capabilities":
      // The offline executor never calls tools; every other backend must be
      // able to satisfy the core agent capabilities before a run starts.
      return settings.llm.provider !== "offline";
    case "slurm":
      return settings.runner === "slurm";
  }
}

/** A probe failure whose `detail` carries the technical evidence. */
export class ReadinessProbeError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ReadinessProbeError";
  }
}

export interface ReadinessProbeOutcome {
  readonly message?: string;
  readonly detail?: string;
}

export interface ReadinessProbeContext {
  readonly settings: ServerSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly searxngInstanceId?: string;
  readonly signal: AbortSignal;
  readonly credentials: {
    readonly anthropicApiKey?: string;
    readonly geminiApiKey?: string;
    readonly claudeSetupToken?: string;
    readonly cursorApiKey?: string;
  };
  /** Live progress line for long checks (queued SLURM probe). */
  readonly onProgress: (message: string) => void;
}

export type ReadinessProbe = (
  context: ReadinessProbeContext,
) => Promise<ReadinessProbeOutcome>;

/** The runnable checks; `registry` is derived from the live registry status. */
export type RunnableReadinessCheckId = Exclude<ReadinessCheckId, "registry">;

export type ReadinessProbes = Readonly<
  Record<RunnableReadinessCheckId, ReadinessProbe>
>;

export interface ReadinessAdviceRequest {
  readonly check: ReadinessCheckId;
  readonly label: string;
  readonly message: string;
  readonly detail?: string;
}

/** Produces LLM fix guidance for a failed check; undefined = no LLM usable. */
export type ReadinessAdvisor = (
  request: ReadinessAdviceRequest,
) => Promise<string | undefined>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env: options.env, timeout: options.timeoutMs, cwd: options.cwd },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new ReadinessProbeError(
              `${command} failed: ${String(stderr || error.message).trim()}`,
              [`$ ${command} ${args.join(" ")}`, String(stdout).trim(), String(stderr).trim()]
                .filter(Boolean)
                .join("\n"),
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("readiness check aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("readiness check aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function tailOfFile(path: string, maxChars = 2000): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// default probes
// ---------------------------------------------------------------------------

export interface DefaultReadinessProbeOptions {
  readonly validateAnthropic: AnthropicConnectionValidator;
  readonly validateClaudeAgent: ClaudeAgentConnectionValidator;
  readonly validateCursorAgent: CursorAgentConnectionValidator;
  readonly validateGemini?: GeminiConnectionValidator;
  /** Ceiling for the whole SLURM probe (submission + queue wait). */
  readonly slurmProbeTimeoutMs?: number;
  /**
   * Held-pilot deployments: verify the pilot pool (markers + one squeue)
   * instead of submitting an sbatch probe job — sbatch is denied on the
   * compute node the server runs on.
   */
  readonly pilotPoolDir?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Loop tick: sentinel-file, abort, and deadline checks — local work only.
 * The sentinel on shared storage is the probe's primary success signal, so
 * a fast tick costs the scheduler nothing.
 */
const SLURM_POLL_MS = 3_000;
/**
 * Scheduler cadence: squeue fires on its own, far slower clock (progress
 * narration and gone-detection only). Shared clusters treat seconds-scale
 * squeue polling as abuse (LRZ policy); the probe is bounded at ~4 minutes,
 * so this costs at most ~8 squeue calls.
 */
const SLURM_SCHEDULER_POLL_MS = 30_000;
/** Grace between "job left the queue" and judging the sentinel missing. */
const SLURM_GONE_GRACE_MS = 15_000;

/**
 * One immediate retry for a probe attempt — the registry probe's doctrine,
 * applied to the launch-time probes. The realistic first-attempt failures on
 * a freshly started host all pass on the second try: cold DNS/proxy caches
 * make the first outbound connection overrun its timeout, and the Claude
 * CLI's first spawn reads a cold package cache off shared storage. Without
 * the retry those show as hard failures on the dashboard's first paint and
 * sit red for the whole recheck cooldown (5-30 minutes) unless a human
 * clicks re-run. A genuinely broken connection fails both attempts and
 * reports the second error. Config errors (missing key/model) are thrown
 * before the attempt and never retried; an aborted probe never retries.
 */
async function attemptTwice<T>(
  signal: AbortSignal,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (signal.aborted) throw error;
    return await attempt();
  }
}

/** SLURM job states that mean the probe is still on its way to running. */
const SLURM_LIVE_STATES =
  /^(PENDING|CONFIGURING|RUNNING|COMPLETING|SUSPENDED|RESIZING)/i;

export function defaultReadinessProbes(
  options: DefaultReadinessProbeOptions,
): ReadinessProbes {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    llm: async (context) => {
      const llm = context.settings.llm;
      if (llm.provider === "anthropic") {
        const apiKey = context.credentials.anthropicApiKey;
        const model = llm.model;
        if (!apiKey || !model) {
          throw new ReadinessProbeError(
            "Configure and verify the Anthropic API key and model in Settings",
          );
        }
        await attemptTwice(context.signal, () =>
          options.validateAnthropic({
            apiKey,
            model,
            ...(llm.baseUrl !== undefined ? { baseUrl: llm.baseUrl } : {}),
          }),
        );
        return { message: `Anthropic API responds · ${llm.model}` };
      }
      if (llm.provider === "gemini") {
        const apiKey = context.credentials.geminiApiKey;
        if (!apiKey || !llm.model) throw new ReadinessProbeError("Configure and verify the Gemini API key and model in Settings");
        await attemptTwice(context.signal, () => (options.validateGemini ?? validateGeminiConnection)({ apiKey, model: llm.model!, ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}) }));
        return { message: `Gemini API model access verified · ${llm.model}` };
      }
      if (llm.provider === "claude-agent") {
        const token = context.credentials.claudeSetupToken;
        if (!token) {
          throw new ReadinessProbeError(
            "Configure and verify the Claude setup token in Settings",
          );
        }
        await attemptTwice(context.signal, () =>
          options.validateClaudeAgent({
            token,
            ...(llm.model !== undefined ? { model: llm.model } : {}),
          }),
        );
        return {
          message: `Claude Agent SDK responds${llm.model ? ` · ${llm.model}` : ""}`,
        };
      }
      if (llm.provider === "cursor-agent") {
        const apiKey = context.credentials.cursorApiKey;
        if (!apiKey) {
          throw new ReadinessProbeError(
            "Configure and verify the Cursor API key in Settings",
          );
        }
        await attemptTwice(context.signal, () =>
          options.validateCursorAgent({
            apiKey,
            ...(llm.model !== undefined ? { model: llm.model } : {}),
          }),
        );
        return {
          message: `Cursor SDK responds${llm.model ? ` · ${llm.model}` : ""}`,
        };
      }
      return { message: "offline provider — no model connection needed" };
    },

    capabilities: async (context) => {
      const localSearchFailure = localWebSearchUnavailable(
        context.workspace,
        context.settings,
        context.searxngInstanceId,
      );
      // The toolless-placer guard, deployment-level: run the SAME capability
      // broker a task's compiler runs, with the SAME inputs the worker wires
      // (provider-native offers per backend, host-tool manifests, the
      // settings' enabled set with the taxonomy force-enable), and verify
      // every core agent capability resolves to a source. A capability that
      // resolves nowhere here would reach agents as "unavailable" mid-run —
      // degraded prompts at best, a failed required-capability task at
      // worst — so it blocks submissions instead.
      const provider = context.settings.llm.provider;
      // The SAME rule the worker wires a run with, from the same place, so this
      // promise cannot drift from what a run does. Modelled with attachment
      // roots PRESENT because that is the question a deployment check answers:
      // if a submission carries files, can the panel read them? A submission
      // with nothing attached has no attachment access and needs none.
      // Search handed to the agents' own tools (webSearch.mode "agent"): the
      // backends' native web tools become provider offers, exactly as the
      // worker wires them.
      const agentWeb = context.settings.webSearch?.mode === "agent" && provider !== "offline";
      const providerOffers = nativeOffersFor(provider, {
        attachmentRootsPresent: true,
        ...(agentWeb ? { nativeWeb: true } : {}),
      });
      const hostTools = [
        ...ATTACHMENT_MANIFESTS,
        ...TAXONOMY_MANIFESTS,
        ...WEB_SEARCH_MANIFESTS,
        ...NOTES_MANIFESTS,
        ...FACT_MANIFESTS,
      ];
      const enabledHostToolIds = new Set<string>(
        context.settings.hostTools?.enabledToolIds ??
          hostTools.filter((manifest) => manifest.defaultEnabled).map((m) => m.toolId),
      );
      // Mirrors the worker's wiring: taxonomy reads are a deployment
      // resource, force-enabled whenever a taxonomy is wired — and every
      // real run wires one (the registry's live store, or the bundle seed).
      for (const manifest of TAXONOMY_MANIFESTS) {
        enabledHostToolIds.add(manifest.toolId);
      }
      // And for the thinker notes: the run's own artifacts back them, so the
      // worker always wires and enables the notes tool.
      for (const manifest of NOTES_MANIFESTS) {
        enabledHostToolIds.add(manifest.toolId);
      }
      // And for the fact table: the run's session directory backs it, so the
      // worker always wires and enables it for a bundle that declares one.
      for (const manifest of FACT_MANIFESTS) {
        enabledHostToolIds.add(manifest.toolId);
      }
      // Same mirror for the host-owned web layer: a run builds a manager
      // whenever ANYTHING backs a search — the keyless scholarly chain (on
      // by default) or a configured general provider — and then enables the
      // web tools. Modelled from the same settings the run's environment is
      // written from, so this promise cannot drift from what a run does.
      {
        const web = context.settings.webSearch;
        const generalBacked =
          web?.provider === "tavily"
            ? web.tavilyKeyConfigured === true
            : web?.provider === "brave"
              ? web.braveKeyConfigured === true
              : web?.provider === "searxng"
                ? typeof web.searxngBaseUrl === "string" && web.searxngBaseUrl !== ""
                : web?.provider === "searxng-local"
                  ? // The app-launched instance counts only while its state
                    // file says it is actually running — a selected-but-dead
                    // launcher must not promise a search no run can make.
                    localSearchFailure === undefined &&
                    searxngLocalUrl(context.workspace, context.searxngInstanceId) !== undefined
                  : false;
        // The paid fallback backs general search on its own (its key set).
        const fallbackBacked = paidWebSearchFallbackAvailable(context.workspace, context.settings);
        const webBacked =
          provider !== "offline" &&
          !agentWeb &&
          (web?.scholarly !== false || generalBacked || fallbackBacked);
        for (const manifest of WEB_SEARCH_MANIFESTS) {
          if (webBacked) enabledHostToolIds.add(manifest.toolId);
          else enabledHostToolIds.delete(manifest.toolId);
        }
        // Agent mode keeps the host's plain web_fetch where the backend has
        // no fetch of its own (the Messages path), as the worker does.
        if (agentWeb) enabledHostToolIds.add("web_fetch");
      }
      const coreCapabilities: CapabilityDeclaration[] = [
        { capabilityId: "web-search", operations: ["web.search", "web.fetch"], whenUnavailable: "" },
        { capabilityId: "code-execution", operations: ["code.execute"], whenUnavailable: "" },
        {
          capabilityId: "attachment-access",
          operations: ["attachment.list", "attachment.read", "attachment.search"],
          whenUnavailable: "",
        },
        {
          capabilityId: "taxonomy-access",
          operations: ["taxonomy.tree", "taxonomy.resolve"],
          whenUnavailable: "",
        },
        { capabilityId: "notes-access", operations: ["notes.search"], whenUnavailable: "" },
        {
          capabilityId: "fact-table",
          operations: ["fact.lookup", "fact.status", "fact.submit"],
          whenUnavailable: "",
        },
      ];
      const plan = resolveCapabilityPlan({
        requiredCapabilities: coreCapabilities,
        providerOffers,
        hostTools,
        enabledHostToolIds,
      });
      const byCapability = new Map<string, Set<string>>();
      for (const operation of plan.operations) {
        const sources = byCapability.get(operation.capabilityId) ?? new Set<string>();
        sources.add(operation.source);
        byCapability.set(operation.capabilityId, sources);
      }
      const unsatisfied = coreCapabilities
        .map((capability) => capability.capabilityId)
        .filter((id) => byCapability.get(id)?.has("unavailable") ?? true);
      if (localSearchFailure && !unsatisfied.includes("web-search")) {
        unsatisfied.push("web-search");
      }
      const detail = plan.operations
        .map((operation) => `${operation.capabilityId} / ${operation.operationId} -> ${operation.source}`)
        .concat(localSearchFailure ? [localSearchFailure.detail] : [])
        .join("\n");
      if (unsatisfied.length > 0) {
        throw new ReadinessProbeError(
          (localSearchFailure ? `${localSearchFailure.message}. ` : "") +
            `${unsatisfied.join(", ")} cannot be satisfied on this deployment — agents that ` +
            "depend on it would run degraded (or fail, where the skill marks it required). " +
            "Re-enable the backing host tools in Settings, or switch to a backend that " +
            "provides the capability natively.",
          detail,
        );
      }
      const summary = coreCapabilities
        .map((capability) => {
          const sources = byCapability.get(capability.capabilityId) ?? new Set<string>();
          // Name every source the capability actually resolves through. The old
          // collapse — "provider" whenever ANY operation was native — reported
          // attachment-access as provider-backed while advertising as host-backed
          // the one operation (search) no provider offers, hiding the split.
          const named = [
            ...(sources.has("provider") ? ["provider"] : []),
            ...(sources.has("host") ? ["host tools"] : []),
          ];
          const source = named.length > 0 ? named.join(" + ") : "nothing";
          const scope =
            capability.capabilityId === "attachment-access"
              ? " (when a submission carries files)"
              : "";
          return `${capability.capabilityId}: ${source}${scope}`;
        })
        .join(" · ");
      // report() adds the current service warning separately, so a later
      // service failure/recovery never leaves a stale fallback notice here.
      return { message: summary, detail };
    },

    internet: async (context) => {
      // Any HTTP response (401 included) proves DNS + TLS + outbound routing;
      // only transport failures reject. The model API host doubles as the
      // most meaningful target: it is the connection the pipeline needs.
      const target =
        context.settings.llm.provider === "cursor-agent"
          ? "https://api.cursor.com/v0/models"
          : context.settings.llm.provider === "gemini"
            ? (context.settings.llm.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/models")
            : "https://api.anthropic.com/v1/models";
      try {
        await attemptTwice(context.signal, async () => {
          await fetchImpl(target, {
            method: "GET",
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(8_000)]),
          });
        });
        return { message: "outbound HTTPS works" };
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new ReadinessProbeError(
          "no outbound HTTPS from this host — web search and the model API are unreachable",
          `GET ${target}\n${cause}`,
        );
      }
    },

    code: async (context) => {
      const root = join(context.workspace, "workspace", "code-env");
      const environment = await prepareCodeWorkspace(root, {
        env: context.env,
        signal: context.signal,
      });
      const python = environment.python
        ? `${environment.python.command} ${environment.python.version}`
        : "python not found (optional)";
      return { message: `scripts run · node ${environment.node.version} · ${python}` };
    },

    slurm: async (context) => {
      // Pilot deployments (server runs AS a SLURM job; sbatch is denied on
      // compute nodes) submit by releasing pre-queued held pilots, so the
      // honest check is the pool itself: are claimable pilots actually
      // queued and held right now? One squeue call — probes run on user
      // action, startup, and slow cooldowns, well within polling etiquette.
      if (options.pilotPoolDir !== undefined) {
        const availableDir = join(options.pilotPoolDir, "available");
        const markers = (() => {
          try {
            return readdirSync(availableDir).filter((name) => /^\d+$/.test(name));
          } catch {
            return [] as string[];
          }
        })();
        if (markers.length === 0) {
          throw new ReadinessProbeError(
            "the pilot pool is empty — top it up from a login node with deploy/lrz-queue-runway.sh",
            `no available/<jobid> markers below ${availableDir}`,
          );
        }
        const cluster =
          readFileSync(join(availableDir, markers[0]!), "utf8").trim() || undefined;
        const listed = await runCommand(
          "squeue",
          [
            ...slurmClusterArgs(cluster),
            "-h",
            "-j",
            markers.join(","),
            "-o",
            "%i %T",
          ],
          { env: context.env, timeoutMs: 8_000 },
        );
        const held = stripSlurmClusterBanners(listed.stdout)
          .split("\n")
          .filter((line) => /\bPENDING\b/i.test(line)).length;
        if (held === 0) {
          throw new ReadinessProbeError(
            "every pilot marker is stale (no held pilot jobs in the queue) — re-run deploy/lrz-queue-runway.sh from a login node",
            listed.stdout.trim() || "(squeue listed none of the marker job ids)",
          );
        }
        return {
          message: `pilot channel ready · ${held} held pilot(s) claimable via scontrol release`,
        };
      }

      await runCommand("sbatch", ["--version"], {
        env: context.env,
        timeoutMs: 8_000,
      }).catch((error: ReadinessProbeError) => {
        throw new ReadinessProbeError(
          "sbatch is not available on this host's PATH",
          error.detail ?? error.message,
        );
      });

      const dir = join(context.workspace, "workspace", "readiness");
      mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const sentinel = join(dir, `probe-${stamp}.ok`);
      const log = join(dir, `probe-${stamp}.log`);
      const scriptPath = join(dir, `probe-${stamp}.sh`);
      // The user's own template is the truest test (their partition, QOS,
      // account); the CLI flags below override its job name/time/output and
      // silence any mail directives for the probe.
      writeFileSync(
        scriptPath,
        renderSlurmTemplate(
          context.settings.slurmTemplate,
          `echo brain-readiness-ok > ${shellQuote(sentinel)}`,
        ),
        { encoding: "utf8", mode: 0o755 },
      );
      context.onProgress("submitting a probe job through the SLURM template…");
      const submitted = await runCommand(
        "sbatch",
        [
          "--parsable",
          "--job-name=brain-readiness",
          "--time=00:03:00",
          `--output=${log}`,
          "--mail-type=NONE",
          scriptPath,
        ],
        { env: context.env, timeoutMs: 15_000, cwd: dir },
      ).catch((error: ReadinessProbeError) => {
        throw new ReadinessProbeError(
          "sbatch rejected the probe job — check partition/QOS/account in the SLURM template",
          error.detail ?? error.message,
        );
      });
      const receipt = slurmSubmissionReceipt(submitted.stdout, submitted.stderr);
      if (!receipt) {
        throw new ReadinessProbeError(
          "sbatch did not return a probe job ID",
          `${slurmSubmissionDiagnostic(submitted.stdout, submitted.stderr)}. A job may have been accepted; check the scheduler before retrying.`,
        );
      }
      const jobId = receipt.jobId;
      // Multi-cluster sites (LRZ) report the landing cluster; polls and
      // cancels need -M for the probe job to be visible to them at all.
      const clusterArgs = slurmClusterArgs(receipt.cluster);
      context.onProgress(`probe job ${jobId} submitted; waiting for the scheduler…`);

      const deadline = Date.now() + (options.slurmProbeTimeoutMs ?? 240_000);
      let goneSince: number | undefined;
      let lastSchedulerPollAt = Number.NEGATIVE_INFINITY;
      const cleanup = (): void => {
        rmSync(scriptPath, { force: true });
        rmSync(sentinel, { force: true });
      };
      for (;;) {
        if (existsSync(sentinel)) {
          cleanup();
          return { message: `sbatch works · probe job ${jobId} ran to completion` };
        }
        if (context.signal.aborted) throw new Error("readiness check aborted");
        if (Date.now() > deadline) {
          await runCommand("scancel", [...clusterArgs, jobId], {
            env: context.env,
            timeoutMs: 5_000,
          }).catch(() => undefined);
          throw new ReadinessProbeError(
            `probe job ${jobId} did not finish in time — the queue may be full or the template's limits too strict`,
            tailOfFile(log),
          );
        }
        if (Date.now() - lastSchedulerPollAt < SLURM_SCHEDULER_POLL_MS) {
          await sleep(SLURM_POLL_MS, context.signal);
          continue;
        }
        lastSchedulerPollAt = Date.now();
        const queueState = await runCommand(
          "squeue",
          ["-h", "-j", jobId, "-o", "%T", ...clusterArgs],
          {
            env: context.env,
            timeoutMs: 5_000,
          },
        )
          .then(
            (result) => stripSlurmClusterBanners(result.stdout).trim() || undefined,
          )
          .catch(() => undefined);
        if (queueState && SLURM_LIVE_STATES.test(queueState)) {
          goneSince = undefined;
          context.onProgress(
            `probe job ${jobId} ${queueState.trim().toLowerCase()} in the queue…`,
          );
        } else {
          // The job left the queue (or squeue is unusable): give the shared
          // filesystem a grace period to surface the sentinel, then judge.
          goneSince ??= Date.now();
          if (Date.now() - goneSince > SLURM_GONE_GRACE_MS) {
            const finalState = await runCommand(
              "sacct",
              ["-n", "-j", jobId, "--format=State", ...clusterArgs],
              { env: context.env, timeoutMs: 5_000 },
            )
              .then(
                (result) =>
                  stripSlurmClusterBanners(result.stdout).trim().split(/\s+/)[0] ?? "",
              )
              .catch(() => "");
            throw new ReadinessProbeError(
              finalState && !/^COMPLETED/i.test(finalState)
                ? `probe job ${jobId} ended in state ${finalState}`
                : `probe job ${jobId} left the queue without writing its result — check shared storage and the probe log`,
              tailOfFile(log),
            );
          }
        }
        await sleep(SLURM_POLL_MS, context.signal);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// built-in fix hints (used when the LLM advisor is unavailable or failed)
// ---------------------------------------------------------------------------

function staticAdvice(id: ReadinessCheckId, settings: ServerSettings): string {
  switch (id) {
    case "llm":
      return settings.llm.provider === "claude-agent"
        ? "Run `claude setup-token` in any terminal where Claude Code is signed in, copy the printed token, then open Settings → Model connection and paste it. The token stays on this server."
        : settings.llm.provider === "cursor-agent"
          ? "Create an API key at https://cursor.com/dashboard (Integrations → API keys, or a team service account), then open Settings → Model connection, paste it, and Save. It is verified with one small request and stored only on this server."
          : settings.llm.provider === "gemini"
            ? "Create a Gemini API key at https://aistudio.google.com/apikey, then open Settings → Model connection, select Gemini API, paste the key, and Save. Model access is checked without generating a response; the key stays on this server."
            : "Create an API key at https://console.anthropic.com (API Keys), then open Settings → Model connection, paste it, and Save. It is verified with one small request and stored only on this server.";
    case "internet":
      return "This host cannot reach the public internet over HTTPS. This check contacts the selected provider with the app's own HTTP stack — curl reaching google.com does not prove it. On HPC clusters compute nodes are often offline: launch the server on a node with outbound access, or export https_proxy/HTTPS_PROXY (your cluster's proxy) before `brain launch` — the app routes its own requests through it (NO_PROXY honored).";
    case "code":
      return "The scratch workspace could not run a script. Check that the workspace path is on writable storage, that the filesystem is not mounted noexec, and that TMPDIR points somewhere writable.";
    case "capabilities":
      return "One or more agent capabilities resolve to no tool on this deployment, so agents depending on them would run degraded (or fail where a skill marks the capability required). Open Settings and re-enable the backing host tools (attachment and taxonomy reads ship enabled by default), or switch to a backend that provides the capability natively. The technical detail lists every operation and where it resolved.";
    case "slurm":
      return "Verify job submission works from this node: `sbatch --version` must succeed and the template's partition/QOS/account must be valid for your user. The probe script and its log are kept under workspace/readiness/ — submit the script manually with sbatch to see the scheduler's own message.";
    case "registry":
      return "The Brain Registry could not be verified: it is unreachable, or it no longer serves the configured bundle's index. Check the registry URL in Settings and that this host can reach it (it serves /health and /v1/index.json over HTTPS). Runs are held rather than started against an unverified registry.";
  }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

interface MutableCheck {
  state: ReadinessCheckState;
  message?: string;
  detail?: string;
  advice?: string;
  advising?: boolean;
  startedAt?: number;
  finishedAt?: number;
}

interface PersistedCheck extends MutableCheck {
  readonly id: RunnableReadinessCheckId;
}

const RUNNABLE_CHECK_IDS: readonly RunnableReadinessCheckId[] = [
  "llm",
  "capabilities",
  "internet",
  "code",
  "slurm",
];

/**
 * A FAILED check re-probes itself after this long. Required checks gate
 * submissions, so a transient failure at launch (a network blip, an
 * unrouted-IPv6 first attempt) must never wedge the gate red until a human
 * finds the recheck button. Cheap local/network probes retry fast; probes
 * that cost money (llm — a real model call) or cluster resources (slurm —
 * a probe job) retry sparingly. Passing checks are never re-run
 * automatically — only user action or a settings change touches them.
 */
const FAILED_RECHECK_COOLDOWN_MS: Record<RunnableReadinessCheckId, number> = {
  llm: 30 * 60_000,
  capabilities: 10 * 60_000,
  internet: 5 * 60_000,
  code: 10 * 60_000,
  slurm: 30 * 60_000,
};

export interface ReadinessServiceOptions {
  readonly workspace: string;
  readonly settings: SettingsStore;
  readonly contentRegistry: ContentRegistryRuntimeStatus;
  readonly probes: ReadinessProbes;
  /** Extra probes override defaults per check (test seam / deployments). */
  readonly probeOverrides?: Partial<ReadinessProbes>;
  readonly advisor?: ReadinessAdvisor;
  readonly env?: NodeJS.ProcessEnv;
  readonly onChange?: () => void;
  readonly now?: () => number;
}

export class ReadinessService {
  private readonly checks = new Map<RunnableReadinessCheckId, MutableCheck>();
  private readonly inFlight = new Set<RunnableReadinessCheckId>();
  private autoRecheckTimer: NodeJS.Timeout | undefined;
  private readonly probes: ReadinessProbes;
  private readonly controller = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly persistPath: string;

  constructor(private readonly options: ReadinessServiceOptions) {
    this.probes = { ...options.probes, ...(options.probeOverrides ?? {}) };
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.persistPath = join(
      options.settings.searxngInstanceId === undefined
        ? options.workspace
        : searxngDir(options.workspace, options.settings.searxngInstanceId),
      "readiness.json",
    );
    for (const id of RUNNABLE_CHECK_IDS) this.checks.set(id, { state: "unknown" });
    this.load();
  }

  /** Loads the last persisted results so a relaunch shows known state. */
  private load(): void {
    const persisted = readJsonFile<{ checks?: PersistedCheck[] }>(this.persistPath);
    for (const entry of persisted?.checks ?? []) {
      const check = this.checks.get(entry.id);
      if (!check) continue;
      check.state = entry.state === "checking" ? "unknown" : entry.state;
      check.message = entry.message;
      check.detail = entry.detail;
      check.advice = entry.advice;
      check.startedAt = entry.startedAt;
      check.finishedAt = entry.finishedAt;
    }
  }

  private persist(): void {
    try {
      atomicWriteJson(this.persistPath, {
        checks: [...this.checks.entries()].map(([id, check]) => ({
          id,
          ...check,
          advising: undefined,
        })),
      });
    } catch {
      // Persistence is a convenience; never fail a check over it.
    }
  }

  private emit(): void {
    this.persist();
    this.options.onChange?.();
  }

  private settings(): ServerSettings {
    return this.options.settings.get();
  }

  report(): ReadinessReport {
    const settings = this.settings();
    const checks: ReadinessCheck[] = READINESS_CHECK_IDS.map((id) => {
      const required = readinessCheckRequired(id, settings);
      const label = READINESS_CHECK_LABELS[id];
      if (!required) {
        return {
          id,
          label,
          required: false,
          state: "skipped",
          message: "not needed with the current settings",
        };
      }
      if (id === "registry") {
        // The shared live-verified status: reachable AND serving the
        // configured bundle's index on the last probe. Never a launch-time
        // snapshot — see the server's registry verification.
        const running = this.options.contentRegistry.running;
        return {
          id,
          label,
          required: true,
          state: running ? "ok" : "failed",
          message: running
            ? (this.options.contentRegistry.url ?? "connected")
            : "Brain Registry could not be verified (unreachable, or not serving the configured bundle)",
          ...(running ? {} : { advice: staticAdvice("registry", settings) }),
        };
      }
      const check = this.checks.get(id)!;
      // Search scope follows the live local service between probe ticks.
      // A failed optional provider is visible but does not erase the host
      // paper tools or opted-in paid fallback that still back web.search.
      const localSearchIssue = id === "capabilities"
        ? localWebSearchIssue(this.options.workspace, settings, this.options.settings.searxngInstanceId)
        : undefined;
      if (localSearchIssue?.blocking) {
        const currentLocalProbe = check.state === "failed" &&
          check.detail?.includes(localSearchIssue.detail) === true;
        return {
          id,
          label,
          required: true,
          state: "failed",
          message: localSearchIssue.message,
          detail: currentLocalProbe ? check.detail! : [
            ...(check.state === "failed" && check.detail ? [check.detail] : []),
            localSearchIssue.detail,
          ].join("\n"),
          advice: currentLocalProbe ? (check.advice ?? LOCAL_SEARCH_ADVICE) : LOCAL_SEARCH_ADVICE,
          ...(currentLocalProbe && check.advising ? { advising: true } : {}),
        };
      }
      if (localSearchIssue && check.state === "ok") {
        return {
          id,
          label,
          required: true,
          state: "ok",
          message: localSearchIssue.message,
          detail: [check.detail, localSearchIssue.detail].filter(Boolean).join("\n"),
          ...(check.startedAt !== undefined ? { startedAt: check.startedAt } : {}),
          ...(check.finishedAt !== undefined ? { finishedAt: check.finishedAt } : {}),
        };
      }
      return {
        id,
        label,
        required: true,
        state: check.state,
        ...(check.message !== undefined ? { message: check.message } : {}),
        ...(check.detail !== undefined ? { detail: check.detail } : {}),
        ...(check.advice !== undefined ? { advice: check.advice } : {}),
        ...(check.advising ? { advising: true } : {}),
        ...(check.startedAt !== undefined ? { startedAt: check.startedAt } : {}),
        ...(check.finishedAt !== undefined ? { finishedAt: check.finishedAt } : {}),
      };
    });
    return {
      checks,
      ready: checks.every((check) => !check.required || check.state === "ok"),
      updatedAt: this.now(),
    };
  }

  /**
   * The failed checks whose recheck cooldown has elapsed — what the
   * auto-recheck loop re-probes on its next scan. Exposed for tests.
   */
  autoRecheckDue(): readonly RunnableReadinessCheckId[] {
    const settings = this.settings();
    return RUNNABLE_CHECK_IDS.filter((id) => {
      const check = this.checks.get(id)!;
      return (
        check.state === "failed" &&
        readinessCheckRequired(id, settings) &&
        !this.inFlight.has(id) &&
        this.now() - (check.finishedAt ?? 0) >= FAILED_RECHECK_COOLDOWN_MS[id]
      );
    });
  }

  /**
   * Heals wedged failures: scans periodically and re-probes failed required
   * checks past their per-check cooldown. onChange (the SSE broadcast)
   * fires through the normal refresh path, so the dashboard icon recovers
   * without anyone pressing recheck.
   */
  startAutoRecheck(scanMs = 60_000): void {
    if (this.autoRecheckTimer) return;
    this.autoRecheckTimer = setInterval(() => {
      const due = this.autoRecheckDue();
      if (due.length > 0) this.refresh(due);
    }, scanMs);
    this.autoRecheckTimer.unref();
  }

  /**
   * Re-evaluates checks asynchronously. Targeted checks flip to "checking"
   * before this returns, so an immediate report shows the pulse. Checks not
   * required under current settings never run.
   */
  refresh(ids?: readonly ReadinessCheckId[]): void {
    const settings = this.settings();
    const targets = RUNNABLE_CHECK_IDS.filter(
      (id) =>
        (ids === undefined || ids.includes(id)) &&
        readinessCheckRequired(id, settings) &&
        !this.inFlight.has(id),
    );
    for (const id of targets) {
      const check = this.checks.get(id)!;
      this.inFlight.add(id);
      check.state = "checking";
      check.message = "checking…";
      check.detail = undefined;
      check.advising = false;
      check.startedAt = this.now();
      check.finishedAt = undefined;
    }
    if (targets.length > 0) this.emit();
    for (const id of targets) {
      void this.runProbe(id).finally(() => {
        this.inFlight.delete(id);
      });
    }
  }

  private async runProbe(id: RunnableReadinessCheckId): Promise<void> {
    const check = this.checks.get(id)!;
    const settings = this.settings();
    try {
      const outcome = await this.probes[id]({
        settings,
        env: this.env,
        workspace: this.options.workspace,
        ...(this.options.settings.searxngInstanceId !== undefined
          ? { searxngInstanceId: this.options.settings.searxngInstanceId }
          : {}),
        signal: this.controller.signal,
        credentials: {
          ...(this.options.settings.getGeminiApiKey() !== undefined ? { geminiApiKey: this.options.settings.getGeminiApiKey() } : {}),
          ...(this.options.settings.getAnthropicApiKey() !== undefined
            ? { anthropicApiKey: this.options.settings.getAnthropicApiKey() }
            : {}),
          ...(this.options.settings.getClaudeSetupToken() !== undefined
            ? { claudeSetupToken: this.options.settings.getClaudeSetupToken() }
            : {}),
          ...(this.options.settings.getCursorApiKey() !== undefined
            ? { cursorApiKey: this.options.settings.getCursorApiKey() }
            : {}),
        },
        onProgress: (message) => {
          if (check.state !== "checking") return;
          check.message = message;
          this.emit();
        },
      });
      check.state = "ok";
      check.message = outcome.message ?? "ok";
      check.detail = outcome.detail;
      check.advice = undefined;
      check.finishedAt = this.now();
      this.emit();
    } catch (error) {
      if (this.controller.signal.aborted) {
        check.state = "unknown";
        check.message = undefined;
        return;
      }
      check.state = "failed";
      check.message = error instanceof Error ? error.message : String(error);
      check.detail = error instanceof ReadinessProbeError ? error.detail : undefined;
      check.finishedAt = this.now();
      this.emit();
      void this.advise(id).catch(() => undefined);
    }
  }

  /**
   * Attaches fix guidance to a failed check: the LLM advisor when a verified
   * model connection exists (never for the llm check itself — a broken model
   * connection cannot debug itself), else the built-in hint.
   */
  async advise(
    id: ReadinessCheckId,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    const settings = this.settings();
    if (id === "registry") return; // report() supplies the static hint
    const check = this.checks.get(id as RunnableReadinessCheckId);
    if (!check || check.state !== "failed") return;
    if (check.advice !== undefined && !options.force) return;
    if (
      id === "capabilities" &&
      !options.force &&
      localWebSearchUnavailable(this.options.workspace, settings, this.options.settings.searxngInstanceId)
    ) {
      // Starting or restarting a known local service needs no model call.
      // A user-requested diagnosis may still use the advisor below.
      check.advice = LOCAL_SEARCH_ADVICE;
      this.emit();
      return;
    }
    const llmUsable =
      id !== "llm" &&
      settings.llm.provider !== "offline" &&
      this.checks.get("llm")?.state !== "failed" &&
      this.options.advisor !== undefined;
    if (!llmUsable) {
      check.advice = staticAdvice(id, settings);
      this.emit();
      return;
    }
    check.advising = true;
    this.emit();
    try {
      const advice = await this.options.advisor!({
        check: id,
        label: READINESS_CHECK_LABELS[id],
        message: check.message ?? "check failed",
        ...(check.detail !== undefined ? { detail: check.detail } : {}),
      });
      check.advice = advice ?? staticAdvice(id, settings);
    } catch {
      check.advice = staticAdvice(id, settings);
    } finally {
      check.advising = false;
      this.emit();
    }
  }

  close(): void {
    if (this.autoRecheckTimer) clearInterval(this.autoRecheckTimer);
    this.autoRecheckTimer = undefined;
    this.controller.abort();
  }
}
