/**
 * Staggered agent launches: every agent task STARTS at least `intervalMs`
 * after the previous one started, so a parallel wave (the first-pass
 * fan-out, a review round's commentors) ramps up one launch at a time
 * instead of hitting the provider, the network, and the node in one
 * aligned burst. Anthropic documents "acceleration limits" — 429s for
 * sharp usage jumps even below the account's ceilings — and a cold
 * process/connection storm on the worker node is the local mirror of the
 * same problem.
 *
 * Semantics: a rolling slot reservation, not fixed ticks. The first task
 * launches immediately; each further task takes the next free slot,
 * `intervalMs` after the previous slot. Outside a burst the previous slot
 * lies in the past, so a lone task never waits. Tasks still RUN fully in
 * parallel — only the moment each one starts is spaced.
 *
 * The wait honors the task's AbortSignal (a cancelled run never sits out
 * its slot), and long waits report themselves as a status progress event
 * so the dashboard's activity feed explains the quiet start instead of
 * showing an agent that seems hung.
 */
import type {
  AgentExecutionContext,
  AgentExecutor,
  AgentResult,
  AgentTask,
} from "@brainstorm-agentic/core";
import { AgentCancelledError } from "@brainstorm-agentic/agent-runtime";

/** Default spacing between agent launches: one launch every 10 seconds. */
export const DEFAULT_LAUNCH_INTERVAL_MS = 10_000;

/** Waits below this stay silent; longer ones explain themselves in the feed. */
const REPORT_WAIT_THRESHOLD_MS = 1_000;

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new AgentCancelledError(signal.reason));
  }
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AgentCancelledError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface StaggeredLaunchOptions {
  /** Minimum time between two agent launches. */
  readonly intervalMs: number;
  /** Injectable clock (tests). */
  readonly now?: () => number;
  /** Injectable abortable sleep (tests). */
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export class StaggeredLaunchAgentExecutor implements AgentExecutor {
  readonly #inner: AgentExecutor;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /** When the next launch slot opens, on this executor's clock. */
  #nextSlotAt = Number.NEGATIVE_INFINITY;

  constructor(inner: AgentExecutor, options: StaggeredLaunchOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
      throw new Error("launch stagger intervalMs must be a non-negative number");
    }
    this.#inner = inner;
    this.#intervalMs = options.intervalMs;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async execute(
    task: AgentTask,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    if (context.signal?.aborted) {
      throw new AgentCancelledError(context.signal.reason);
    }
    // The slot is reserved synchronously: concurrent callers each advance
    // the shared cursor before any of them awaits, so a wave lines up on
    // interval boundaries in arrival order.
    const slotAt = Math.max(this.#now(), this.#nextSlotAt);
    this.#nextSlotAt = slotAt + this.#intervalMs;
    const wait = slotAt - this.#now();
    if (wait > 0) {
      if (wait >= REPORT_WAIT_THRESHOLD_MS) {
        context.reportProgress?.({
          kind: "status",
          message:
            `Launch staggered: starting in ${Math.round(wait / 1000)}s ` +
            `(agent starts are spaced ${Math.round(this.#intervalMs / 1000)}s apart)`,
        });
      }
      await this.#sleep(wait, context.signal);
    }
    return this.#inner.execute(task, context);
  }
}

/**
 * The launch interval a provider configuration resolves to: an explicit
 * value always wins (0 disables the stagger); otherwise network-backed
 * providers space launches at the default and offline runs — deterministic,
 * local, used by the test suites — never wait.
 */
export function launchIntervalFor(config: {
  readonly provider: "anthropic" | "claude-agent" | "offline";
  readonly launchIntervalMs?: number;
}): number {
  if (config.launchIntervalMs !== undefined) return config.launchIntervalMs;
  return config.provider === "offline" ? 0 : DEFAULT_LAUNCH_INTERVAL_MS;
}
