/**
 * Host-side code execution satisfying the `code-execution` capability.
 *
 * Design: provider-native execution is always preferred (Anthropic's
 * code_execution server tool; Claude Code's own Bash) — the capability broker
 * resolves it that way. This host backend exists for everything the provider
 * cannot cover: deployments without native execution, and the environment
 * readiness probe that verifies scripts can actually run on this host at all
 * (HPC nodes routinely ship nothing beyond a shell).
 *
 * Self-sufficiency: JavaScript always runs — the interpreter is the same
 * Node binary this process runs on (`process.execPath`), which every install
 * carries by construction. Python is detected best-effort (`python3`, then
 * `python`); when absent the tool answers python requests with an honest
 * refusal instead of failing the task.
 *
 * Isolation is process-level only (no root, no namespaces on shared HPC
 * hosts): a scratch directory per call, a scrubbed environment (no
 * credentials or app configuration), bounded runtime and output, and
 * SIGKILL on timeout. This is why the manifest stays risk "high" and
 * default-disabled — the user opts in through settings.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { HostToolManifest, JsonValue, Tool } from "@brainstorm-agentic/core";

// ---------------------------------------------------------------------------
// Execution primitives
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  /** True when the process was killed at the timeout. */
  readonly timedOut: boolean;
}

/** Per-stream output cap; enough for numeric checks, never a data dump. */
const MAX_STREAM_CHARS = 48_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

/**
 * Environment a sandboxed script sees: a small allow-list. Credentials,
 * provider settings, and scheduler variables never cross into user code.
 */
function scrubbedEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "TERM"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of keep) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  return env;
}

export interface RunProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Spawns one bounded process and captures capped stdout/stderr. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      const current = target === "stdout" ? stdout : stderr;
      if (current.length >= MAX_STREAM_CHARS) {
        truncated = true;
        return;
      }
      const room = MAX_STREAM_CHARS - current.length;
      const kept = text.length > room ? text.slice(0, room) : text;
      if (kept.length < text.length) truncated = true;
      if (target === "stdout") stdout += kept;
      else stderr += kept;
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    killTimer.unref();
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: ExecutionResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    child.once("error", (error) => finish(error));
    child.once("close", (code, signalName) => {
      finish({
        exitCode: code ?? (signalName ? 128 : 1),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated,
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Workspace preparation (used by the server readiness probe and the worker)
// ---------------------------------------------------------------------------

export interface CodeRuntime {
  /** Interpreter invocation (absolute node path; python command name). */
  readonly command: string;
  readonly version: string;
}

export interface CodeRuntimeEnvironment {
  /** Scratch root every execution creates its per-call directory under. */
  readonly root: string;
  /** Always present: the Node binary this process runs on. */
  readonly node: CodeRuntime;
  /** Present when a working python3/python interpreter was found. */
  readonly python?: CodeRuntime;
}

export interface PrepareCodeWorkspaceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Candidate python commands, tried in order. */
  readonly pythonCandidates?: readonly string[];
}

/**
 * Prepares a self-sufficient scratch workspace and proves scripts can run in
 * it: creates the root, executes a probe through our own Node binary
 * (guaranteed present on any host that runs this app), and detects an
 * optional python interpreter. Throws with the probe's stderr when even the
 * Node probe cannot run — that is a real environment defect (unwritable or
 * noexec storage), not a missing dependency.
 */
export async function prepareCodeWorkspace(
  root: string,
  options: PrepareCodeWorkspaceOptions = {},
): Promise<CodeRuntimeEnvironment> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const env = scrubbedEnvironment(options.env ?? process.env);
  const probeDir = mkdtempSync(join(root, "probe-"));
  try {
    const nodeProbe = await runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("brain-code-ok " + process.version)'],
      { cwd: probeDir, env, timeoutMs: 15_000, ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (nodeProbe.exitCode !== 0 || !nodeProbe.stdout.includes("brain-code-ok")) {
      throw new Error(
        `the scratch workspace cannot run scripts (node probe exit ${nodeProbe.exitCode}): ` +
          `${(nodeProbe.stderr || nodeProbe.stdout).trim() || "no output"}`,
      );
    }
    const nodeVersion = nodeProbe.stdout.replace("brain-code-ok", "").trim();

    let python: CodeRuntime | undefined;
    for (const candidate of options.pythonCandidates ?? ["python3", "python"]) {
      try {
        const probe = await runProcess(
          candidate,
          ["-c", 'import sys; print("brain-code-ok", sys.version.split()[0])'],
          { cwd: probeDir, env, timeoutMs: 15_000, ...(options.signal ? { signal: options.signal } : {}) },
        );
        if (probe.exitCode === 0 && probe.stdout.includes("brain-code-ok")) {
          python = {
            command: candidate,
            version: probe.stdout.replace("brain-code-ok", "").trim(),
          };
          break;
        }
      } catch {
        // Candidate not installed; try the next one.
      }
    }
    return {
      root,
      node: { command: process.execPath, version: nodeVersion },
      ...(python ? { python } : {}),
    };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const CODE_EXECUTE_MANIFEST: HostToolManifest = {
  toolId: "code_execute",
  displayName: "Code Execute (host)",
  operations: ["code.execute"],
  risk: "high",
  defaultEnabled: false,
  definition: {
    name: "code_execute",
    description:
      "Run a short, self-contained Python or JavaScript script in a scratch workspace on the " +
      "host. Returns stdout, stderr, and the exit code. Process-level isolation only: bounded " +
      "runtime and output, scrubbed environment, per-call scratch directory.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "javascript"],
          description: "Script language.",
        },
        code: {
          type: "string",
          description: "Self-contained script source code.",
        },
        timeout_ms: {
          type: "integer",
          description: "Maximum execution time in milliseconds.",
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
        },
      },
      required: ["language", "code"],
      additionalProperties: false,
    },
  },
};

export const CODE_EXECUTION_MANIFESTS: readonly HostToolManifest[] = [
  CODE_EXECUTE_MANIFEST,
];

export const CODE_EXECUTION_TOOL_NAMES = ["code_execute"] as const;

// ---------------------------------------------------------------------------
// Runtime tool factory
// ---------------------------------------------------------------------------

function refusal(message: string): { output: JsonValue; isError: true } {
  return { output: message, isError: true };
}

/**
 * Creates the executable `code_execute` tool over a prepared workspace.
 * Register it on the tool registry for chat-completion provider paths whose
 * provider offers no native code execution.
 */
export function codeExecutionTools(
  environment: CodeRuntimeEnvironment,
  baseEnv: NodeJS.ProcessEnv = process.env,
): readonly Tool[] {
  const tool: Tool = {
    definition: CODE_EXECUTE_MANIFEST.definition,
    async execute(input, context) {
      const record =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, JsonValue>)
          : {};
      const language = record.language;
      const code = record.code;
      if (
        (language !== "python" && language !== "javascript") ||
        typeof code !== "string" ||
        code.trim().length === 0
      ) {
        return refusal(
          'code_execute requires `language` ("python" | "javascript") and non-empty `code`.',
        );
      }
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(
          1000,
          typeof record.timeout_ms === "number" ? record.timeout_ms : DEFAULT_TIMEOUT_MS,
        ),
      );
      if (language === "python" && environment.python === undefined) {
        return refusal(
          "No python interpreter is available on this host; rewrite the check in JavaScript " +
            "(language \"javascript\") or reason without executing it.",
        );
      }

      const scratch = mkdtempSync(join(environment.root, "run-"));
      try {
        const file = join(scratch, language === "python" ? "script.py" : "script.mjs");
        writeFileSync(file, code, "utf8");
        const runtime = language === "python" ? environment.python! : environment.node;
        const result = await runProcess(runtime.command, [file], {
          cwd: scratch,
          env: scrubbedEnvironment(baseEnv),
          timeoutMs,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return {
          output: {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            truncated: result.truncated,
            timedOut: result.timedOut,
          },
          // A non-zero exit is a legitimate result the model must read
          // (failed assertion, raised exception); only a timeout is flagged.
          ...(result.timedOut ? { isError: true as const } : {}),
        };
      } catch (error) {
        return refusal(
          `code_execute could not run the script: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
  return [tool];
}
