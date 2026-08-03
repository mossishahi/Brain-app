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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  ANTHROPIC_ADAPTER,
  CLAUDE_AGENT_ADAPTER,
  resolveCapabilityPlan,
  type CapabilityDeclaration,
} from "@brainstorm-agentic/core";
import {
  ATTACHMENT_MANIFESTS,
  TAXONOMY_MANIFESTS,
  prepareCodeWorkspace,
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
import type { ContentRegistryRuntimeStatus } from "./model.js";
import type {
  AnthropicConnectionValidator,
  ClaudeAgentConnectionValidator,
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
  readonly signal: AbortSignal;
  readonly credentials: {
    readonly anthropicApiKey?: string;
    readonly claudeSetupToken?: string;
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
  /** Ceiling for the whole SLURM probe (submission + queue wait). */
  readonly slurmProbeTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const SLURM_POLL_MS = 3_000;
/** Grace between "job left the queue" and judging the sentinel missing. */
const SLURM_GONE_GRACE_MS = 15_000;

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
        if (!context.credentials.anthropicApiKey || !llm.model) {
          throw new ReadinessProbeError(
            "Configure and verify the Anthropic API key and model in Settings",
          );
        }
        await options.validateAnthropic({
          apiKey: context.credentials.anthropicApiKey,
          model: llm.model,
          ...(llm.baseUrl !== undefined ? { baseUrl: llm.baseUrl } : {}),
        });
        return { message: `Anthropic API responds · ${llm.model}` };
      }
      if (llm.provider === "claude-agent") {
        if (!context.credentials.claudeSetupToken) {
          throw new ReadinessProbeError(
            "Configure and verify the Claude setup token in Settings",
          );
        }
        await options.validateClaudeAgent({
          token: context.credentials.claudeSetupToken,
          ...(llm.model !== undefined ? { model: llm.model } : {}),
        });
        return {
          message: `Claude Agent SDK responds${llm.model ? ` · ${llm.model}` : ""}`,
        };
      }
      return { message: "offline provider — no model connection needed" };
    },

    capabilities: async (context) => {
      // The toolless-placer guard, deployment-level: run the SAME capability
      // broker a task's compiler runs, with the SAME inputs the worker wires
      // (provider-native offers per backend, host-tool manifests, the
      // settings' enabled set with the taxonomy force-enable), and verify
      // every core agent capability resolves to a source. A capability that
      // resolves nowhere here would reach agents as "unavailable" mid-run —
      // degraded prompts at best, a failed required-capability task at
      // worst — so it blocks submissions instead.
      const provider = context.settings.llm.provider;
      const providerOffers =
        provider === "anthropic"
          ? ANTHROPIC_ADAPTER.staticOffers
          : provider === "claude-agent"
            ? CLAUDE_AGENT_ADAPTER.staticOffers
            : [];
      const hostTools = [...ATTACHMENT_MANIFESTS, ...TAXONOMY_MANIFESTS];
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
      const coreCapabilities: CapabilityDeclaration[] = [
        { capabilityId: "web-search", operations: ["web.search", "web.fetch"], whenUnavailable: "" },
        { capabilityId: "code-execution", operations: ["code.execute"], whenUnavailable: "" },
        {
          capabilityId: "attachment-access",
          operations: ["attachment.list", "attachment.read"],
          whenUnavailable: "",
        },
        {
          capabilityId: "taxonomy-access",
          operations: ["taxonomy.tree", "taxonomy.resolve"],
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
      const detail = plan.operations
        .map((operation) => `${operation.capabilityId} / ${operation.operationId} -> ${operation.source}`)
        .join("\n");
      if (unsatisfied.length > 0) {
        throw new ReadinessProbeError(
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
          const source = sources.has("provider") ? "provider" : "host tools";
          return `${capability.capabilityId}: ${source}`;
        })
        .join(" · ");
      return { message: summary, detail };
    },

    internet: async (context) => {
      // Any HTTP response (401 included) proves DNS + TLS + outbound routing;
      // only transport failures reject. The model API host doubles as the
      // most meaningful target: it is the connection the pipeline needs.
      const target = "https://api.anthropic.com/v1/models";
      try {
        await fetchImpl(target, {
          method: "GET",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(8_000)]),
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
      const match = /Submitted batch job\s+(\S+)/.exec(submitted.stdout);
      if (!match) {
        throw new ReadinessProbeError(
          "sbatch returned an unrecognized response",
          submitted.stdout.trim(),
        );
      }
      const jobId = match[1]!;
      context.onProgress(`probe job ${jobId} submitted; waiting for the scheduler…`);

      const deadline = Date.now() + (options.slurmProbeTimeoutMs ?? 240_000);
      let goneSince: number | undefined;
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
          await runCommand("scancel", [jobId], {
            env: context.env,
            timeoutMs: 5_000,
          }).catch(() => undefined);
          throw new ReadinessProbeError(
            `probe job ${jobId} did not finish in time — the queue may be full or the template's limits too strict`,
            tailOfFile(log),
          );
        }
        const queueState = await runCommand("squeue", ["-h", "-j", jobId, "-o", "%T"], {
          env: context.env,
          timeoutMs: 5_000,
        })
          .then((result) => result.stdout.trim() || undefined)
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
              ["-n", "-j", jobId, "--format=State"],
              { env: context.env, timeoutMs: 5_000 },
            )
              .then((result) => result.stdout.trim().split(/\s+/)[0] ?? "")
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
        : "Create an API key at https://console.anthropic.com (API Keys), then open Settings → Model connection, paste it, and Save. It is verified with one small request and stored only on this server.";
    case "internet":
      return "This host cannot reach the public internet over HTTPS. On HPC clusters compute nodes are often offline: launch the server on a node with outbound access, or export https_proxy/HTTPS_PROXY (your cluster's proxy) in the launch script before `brain launch`.";
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
  private readonly probes: ReadinessProbes;
  private readonly controller = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly persistPath: string;

  constructor(private readonly options: ReadinessServiceOptions) {
    this.probes = { ...options.probes, ...(options.probeOverrides ?? {}) };
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.persistPath = join(options.workspace, "readiness.json");
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
        signal: this.controller.signal,
        credentials: {
          ...(this.options.settings.getAnthropicApiKey() !== undefined
            ? { anthropicApiKey: this.options.settings.getAnthropicApiKey() }
            : {}),
          ...(this.options.settings.getClaudeSetupToken() !== undefined
            ? { claudeSetupToken: this.options.settings.getClaudeSetupToken() }
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
    this.controller.abort();
  }
}
