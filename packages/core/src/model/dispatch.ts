/**
 * The request coordinator: a per-process queue that decides WHEN each model
 * request is sent, driven by what the provider itself declares about its
 * timing — live budget headers on every response, and the reset time carried
 * by a rate-limit rejection.
 *
 * Tasks stay fully parallel; only the moment a request goes on the wire is
 * scheduled. When the provider's declarations show headroom, acquire()
 * resolves immediately and adds no latency at all. When one request learns
 * about a wall (a 429, or a budget header at zero), block() pauses EVERY
 * pending dispatch until the declared reset — one task's discovery informs
 * the whole herd, instead of forty tasks each burning a round trip to find
 * the same wall and backing off on their own clocks.
 *
 * Two priority classes keep a run's critical path short: a seat's judge or
 * redeveloper call (one per seat, gating its whole round) is released before
 * other seats' comment floods when a block lifts.
 *
 * Blocks only ever extend and then expire — an in-flight response observed
 * AFTER a block was declared was sent BEFORE the wall and must not shorten
 * it.
 */

export type DispatchPriority = "normal" | "high";

/** What one provider response declared about the remaining budgets. */
export interface RateObservation {
  readonly requestsRemaining?: number;
  /** Epoch ms when the request budget replenishes. */
  readonly requestsResetAt?: number;
  readonly inputTokensRemaining?: number;
  readonly inputTokensResetAt?: number;
  readonly outputTokensRemaining?: number;
  readonly outputTokensResetAt?: number;
}

/**
 * The contract a paced provider talks to. Implementations must be safe for
 * any number of concurrent acquire() callers in one process.
 */
export interface RequestCoordinator {
  /** Resolves when the request may be sent. Honors the abort signal. */
  acquire(priority?: DispatchPriority, signal?: AbortSignal): Promise<void>;
  /** Feeds the budgets a response's headers declared. */
  observe(observation: RateObservation): void;
  /** Pauses all dispatch until the given time (never shortens a block). */
  block(untilMs: number, reason: string): void;
}

/** Margin added past a declared reset so the first retry lands inside it. */
const RESET_MARGIN_MS = 250;

interface Waiter {
  readonly priority: DispatchPriority;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

function abortError(reason?: unknown): Error {
  const error = new Error(
    typeof reason === "string" ? reason : "request dispatch was cancelled",
  );
  error.name = "AbortError";
  return error;
}

/**
 * The header-driven coordinator. One instance per worker process serves every
 * task of the run; providers without declarations simply never block it.
 */
export class RateCoordinator implements RequestCoordinator {
  readonly #now: () => number;
  #blockedUntil = 0;
  #blockReason = "";
  #waiters: Waiter[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** The active block's expiry (0 when dispatch is open); for observability. */
  get blockedUntil(): number {
    return this.#blockedUntil > this.#now() ? this.#blockedUntil : 0;
  }

  acquire(
    priority: DispatchPriority = "normal",
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal.reason));
    }
    if (this.#blockedUntil <= this.#now()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        resolve,
        reject,
        signal,
        onAbort: signal
          ? () => {
              this.#waiters = this.#waiters.filter((entry) => entry !== waiter);
              reject(abortError(signal.reason));
            }
          : undefined,
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort!, { once: true });
      this.#scheduleDrain();
    });
  }

  observe(observation: RateObservation): void {
    const axes: readonly [number | undefined, number | undefined, string][] = [
      [observation.requestsRemaining, observation.requestsResetAt, "request budget exhausted"],
      [observation.inputTokensRemaining, observation.inputTokensResetAt, "input token budget exhausted"],
      [observation.outputTokensRemaining, observation.outputTokensResetAt, "output token budget exhausted"],
    ];
    for (const [remaining, resetAt, reason] of axes) {
      if (remaining === 0 && typeof resetAt === "number" && resetAt > this.#now()) {
        this.block(resetAt, reason);
      }
    }
  }

  block(untilMs: number, reason: string): void {
    const target = untilMs + RESET_MARGIN_MS;
    if (target <= this.#blockedUntil) return;
    this.#blockedUntil = target;
    this.#blockReason = reason;
    this.#scheduleDrain();
  }

  #scheduleDrain(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const wait = Math.max(0, this.#blockedUntil - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#drain();
    }, wait);
    // A pending queue must never hold the process open on its own.
    this.#timer.unref?.();
  }

  #drain(): void {
    if (this.#blockedUntil > this.#now()) {
      // The block was extended while the timer slept; keep waiting.
      this.#scheduleDrain();
      return;
    }
    const released = this.#waiters;
    this.#waiters = [];
    // High-priority waiters resume first, so a round's single gating call
    // (judge, redeveloper) never queues behind another seat's comment flood.
    released.sort((a, b) =>
      a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1,
    );
    for (const waiter of released) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve();
    }
  }
}
