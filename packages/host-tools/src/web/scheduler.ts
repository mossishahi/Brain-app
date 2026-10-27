/**
 * Scheduling primitives for the run's search coordinator.
 *
 * One run has many agents searching at once. The coordinator (the
 * WebAccessManager) keeps them from overwhelming any upstream with three
 * small pieces, all driven by an injectable clock so tests are exact:
 *
 * - TokenBucket: a steady request rate with a small burst and optional random
 *   spacing, one per upstream (each provider, each SearXNG engine). Waiters
 *   are served in arrival order; the rate can be lowered after a block and
 *   raised again after clean requests.
 * - FairGate: the run-wide concurrency bound, served round-robin across
 *   agents, so one agent with a long queue of searches cannot starve the
 *   others.
 * - Breaker: the cool-down of one upstream after a block (CAPTCHA, 403, 429)
 *   or repeated failures. The cool-down doubles on repeated blocks, and once
 *   it expires exactly one trial request is let through.
 */

export interface SchedulerClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("aborted");
}

/** Wall-clock scheduling with abortable sleeps. */
export const SYSTEM_CLOCK: SchedulerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  random: () => Math.random(),
};

export interface TokenBucketOptions {
  /** Sustained rate. */
  readonly perMinute: number;
  /** Requests that may start back to back after an idle period (>= 1). */
  readonly burst: number;
  /**
   * Random extra spacing after each start, as a fraction of the mean
   * interval (0.3 = up to 30% of 60000/perMinute ms). 0 disables it.
   */
  readonly jitter?: number;
  readonly clock?: SchedulerClock;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private ratePerMs: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly burst: number;
  private readonly jitter: number;
  private readonly clock: SchedulerClock;

  constructor(options: TokenBucketOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.burst = Math.max(1, Math.floor(options.burst));
    this.jitter = Math.max(0, options.jitter ?? 0);
    this.ratePerMs = Math.max(0.01, options.perMinute) / 60_000;
    this.tokens = this.burst;
    this.last = this.clock.now();
  }

  /** The current sustained rate. */
  get perMinute(): number {
    return this.ratePerMs * 60_000;
  }

  /** Changes the sustained rate (AIMD after blocks and clean streaks). */
  setPerMinute(perMinute: number): void {
    this.refill();
    this.ratePerMs = Math.max(0.01, perMinute) / 60_000;
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.last) * this.ratePerMs);
    this.last = now;
  }

  /** Milliseconds until one token is free; 0 when one is free now. */
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.ratePerMs);
  }

  /** Takes one token if one is free right now. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Takes one token, waiting in arrival order behind earlier callers. */
  take(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        if (signal?.aborted) throw abortReason(signal);
        const wait = this.waitMs();
        if (wait <= 0) break;
        await this.clock.sleep(wait, signal);
      }
      this.tokens -= 1;
      if (this.jitter > 0) {
        const spacing = (60_000 / this.perMinute) * this.jitter * this.clock.random();
        if (spacing >= 1) await this.clock.sleep(spacing, signal);
      }
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}

/** A concurrency bound shared by every agent of a run, served round-robin. */
export class FairGate {
  private active = 0;
  private readonly waiting = new Map<string, (() => void)[]>();
  private readonly order: string[] = [];

  constructor(private readonly limit: number) {}

  /** Number of callers holding a slot. */
  get inFlight(): number {
    return this.active;
  }

  /** Callers waiting for a slot, across all agents. */
  get queued(): number {
    let total = 0;
    for (const list of this.waiting.values()) total += list.length;
    return total;
  }

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit && this.order.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const list = this.waiting.get(key) ?? [];
      const onAbort = () => {
        const index = list.indexOf(grant);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) {
          this.waiting.delete(key);
          const at = this.order.indexOf(key);
          if (at >= 0) this.order.splice(at, 1);
        }
        reject(abortReason(signal!));
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.releaser());
      };
      list.push(grant);
      this.waiting.set(key, list);
      if (!this.order.includes(key)) this.order.push(key);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit && this.order.length > 0) {
      const key = this.order.shift()!;
      const list = this.waiting.get(key);
      const next = list?.shift();
      if (list !== undefined && list.length > 0) this.order.push(key);
      else this.waiting.delete(key);
      if (next === undefined) continue;
      this.active += 1;
      next();
    }
  }
}

export interface BreakerOptions {
  /** Cool-down after the first block. */
  readonly baseCooldownMs: number;
  /** Ceiling for the doubling cool-down. */
  readonly maxCooldownMs: number;
  /** Consecutive ordinary failures (timeouts, 5xx) that count as one block. */
  readonly errorThreshold: number;
  /** Cool-down after repeated ordinary failures. */
  readonly errorCooldownMs: number;
  readonly clock?: SchedulerClock;
}

export type BreakerState = "closed" | "open" | "trial";

export class Breaker {
  private blockedUntil = 0;
  private strikes = 0;
  private errors = 0;
  private trialOpen = false;
  private reason: string | undefined;
  private readonly clock: SchedulerClock;

  constructor(private readonly options: BreakerOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  /** "open" while cooling down; "trial" once one test request may go. */
  state(): BreakerState {
    if (this.clock.now() < this.blockedUntil) return "open";
    return this.strikes > 0 ? "trial" : "closed";
  }

  /** Epoch ms when the current cool-down ends (0 when not cooling down). */
  get until(): number {
    return this.clock.now() < this.blockedUntil ? this.blockedUntil : 0;
  }

  get lastReason(): string | undefined {
    return this.reason;
  }

  /**
   * Whether a request may go now. In the trial state exactly one request is
   * admitted until its outcome is reported.
   */
  admit(): boolean {
    const state = this.state();
    if (state === "open") return false;
    if (state === "trial") {
      if (this.trialOpen) return false;
      this.trialOpen = true;
    }
    return true;
  }

  success(): void {
    this.strikes = 0;
    this.errors = 0;
    this.trialOpen = false;
    this.blockedUntil = 0;
    this.reason = undefined;
  }

  /** A block (CAPTCHA, access denied, 429): cool down, doubling on repeats. */
  block(reason: string, minimumMs = 0): number {
    this.strikes += 1;
    this.errors = 0;
    this.trialOpen = false;
    const doubled = this.options.baseCooldownMs * 2 ** (this.strikes - 1);
    const cooldown = Math.min(this.options.maxCooldownMs, Math.max(minimumMs, doubled));
    this.blockedUntil = this.clock.now() + cooldown;
    this.reason = reason;
    return cooldown;
  }

  /** An ordinary failure; enough of them in a row count as a short block. */
  failure(reason: string): void {
    this.trialOpen = false;
    this.errors += 1;
    this.reason = reason;
    if (this.errors >= this.options.errorThreshold) {
      this.errors = 0;
      this.strikes = Math.max(1, this.strikes);
      this.blockedUntil = this.clock.now() + this.options.errorCooldownMs;
    }
  }
}
