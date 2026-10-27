/**
 * The SearXNG engine pool: which engines one metasearch call may use.
 *
 * SearXNG asks every enabled engine for every query unless it is told
 * otherwise. Scraped engines (Google, Yahoo, Startpage, ...) block traffic
 * that looks automated, so the coordinator never lets SearXNG fan out: each
 * call names its engines explicitly (the `engines` request parameter), and
 * this pool decides which ones, per ROUTE:
 *
 * - each engine has its own token bucket (default 6/min, burst 2, up to 30%
 *   random spacing) and a daily cap;
 * - a block (CAPTCHA, access denied, too many requests, SearXNG's own
 *   suspension) puts the engine in a doubling cool-down and halves its rate;
 *   20 clean answers in a row raise the rate by one per minute again;
 * - the launch check ranks engines by known-answer queries, so an engine
 *   that answers but never finds the target (Bing from a university network,
 *   for example) is used only when nothing better is free;
 * - a call waits (bounded) for the earliest free engine rather than bursting.
 */
import type {
  WebSearchEngineFailure,
  WebSearchRoute,
  WebSourceState,
  WebSourceStatus,
} from "@brainstorm-agentic/core";

import { Breaker, SYSTEM_CLOCK, TokenBucket, type SchedulerClock } from "./scheduler.js";

/** Route keys the pool schedules; "paper-science" is SearXNG's science engines. */
export type EngineRoute = WebSearchRoute | "paper-science";

export interface EnginePoolOptions {
  /** Candidate engines per route, in preference order before any check. */
  readonly byRoute: Partial<Record<EngineRoute, readonly string[]>>;
  /** Engines asked per call, per route. Default 1 (paper lookups and news 2). */
  readonly perQuery?: Partial<Record<EngineRoute, number>>;
  readonly perMinute?: number;
  readonly burst?: number;
  readonly jitter?: number;
  readonly minPerMinute?: number;
  readonly maxPerMinute?: number;
  /** Clean answers in a row before the rate rises by one per minute. */
  readonly cleanStreakToRaise?: number;
  /** Longest a call waits for a free engine before the next provider. */
  readonly maxWaitMs?: number;
  /** Requests per engine per UTC day. */
  readonly dailyCap?: number;
  readonly baseCooldownMs?: number;
  readonly maxCooldownMs?: number;
  readonly clock?: SchedulerClock;
}

/** One known-answer query for the engine check. */
export interface EngineCanary {
  readonly query: string;
  /** A target URL pattern that must appear in the top five; absent = any result passes. */
  readonly expect?: RegExp;
  readonly route: EngineRoute;
}

/** What one engine returned for one call, for the pool's bookkeeping. */
export interface EngineOutcome {
  readonly engine: string;
  /** Hits this engine contributed (from the per-result `engines` lists). */
  readonly hits: number;
  /** Its failure inside the answer, when SearXNG reported one. */
  readonly failure?: string;
}

const BLOCK_PATTERN = /captcha|access denied|too many requests|suspended|forbidden|\b403\b|\b429\b/i;

/** SearXNG's own suspension for a CAPTCHA is an hour; never retry sooner. */
const CAPTCHA_MINIMUM_MS = 60 * 60_000;

class EngineLane {
  readonly bucket: TokenBucket;
  readonly breaker: Breaker;
  clean = 0;
  used = 0;
  day = "";
  checkState: WebSourceState = "unchecked";
  checkScore = 0;
  checkDetail: string | undefined;
  checkedAt: number | undefined;

  constructor(
    readonly name: string,
    options: Required<Pick<EnginePoolOptions, "perMinute" | "burst" | "jitter" | "baseCooldownMs" | "maxCooldownMs">>,
    clock: SchedulerClock,
  ) {
    this.bucket = new TokenBucket({
      perMinute: options.perMinute,
      burst: options.burst,
      jitter: options.jitter,
      clock,
    });
    this.breaker = new Breaker({
      baseCooldownMs: options.baseCooldownMs,
      maxCooldownMs: options.maxCooldownMs,
      errorThreshold: 3,
      errorCooldownMs: 5 * 60_000,
      clock,
    });
  }
}

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export class EnginePool {
  private readonly lanes = new Map<string, EngineLane>();
  private readonly byRoute: Partial<Record<EngineRoute, readonly string[]>>;
  private readonly perQuery: Partial<Record<EngineRoute, number>>;
  private readonly minPerMinute: number;
  private readonly maxPerMinute: number;
  private readonly cleanStreakToRaise: number;
  private readonly maxWaitMs: number;
  private readonly dailyCap: number;
  private readonly clock: SchedulerClock;

  constructor(options: EnginePoolOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.byRoute = options.byRoute;
    this.perQuery = options.perQuery ?? { "paper-lookup": 2, news: 2 };
    this.minPerMinute = options.minPerMinute ?? 2;
    this.maxPerMinute = options.maxPerMinute ?? 10;
    this.cleanStreakToRaise = options.cleanStreakToRaise ?? 20;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.dailyCap = options.dailyCap ?? 600;
    const laneOptions = {
      perMinute: options.perMinute ?? 6,
      burst: options.burst ?? 2,
      jitter: options.jitter ?? 0.3,
      baseCooldownMs: options.baseCooldownMs ?? 30 * 60_000,
      maxCooldownMs: options.maxCooldownMs ?? 24 * 60 * 60_000,
    };
    for (const names of Object.values(options.byRoute)) {
      for (const name of names ?? []) {
        if (!this.lanes.has(name)) this.lanes.set(name, new EngineLane(name, laneOptions, this.clock));
      }
    }
  }

  /** Every engine the pool knows. */
  engineNames(): readonly string[] {
    return [...this.lanes.keys()];
  }

  /** Whether any engine could serve this route (now or after a wait). */
  serves(route: EngineRoute): boolean {
    return (this.byRoute[route]?.length ?? 0) > 0;
  }

  private lane(name: string): EngineLane {
    return this.lanes.get(name)!;
  }

  private underCap(lane: EngineLane): boolean {
    const today = utcDay(this.clock.now());
    if (lane.day !== today) {
      lane.day = today;
      lane.used = 0;
    }
    return lane.used < this.dailyCap;
  }

  /**
   * The route's usable engines, best first: engines that passed the check,
   * then unchecked ones in configured order, then degraded ones. Engines in
   * cool-down, at their daily cap, or found blocked/unreachable are left out.
   */
  private candidates(route: EngineRoute): EngineLane[] {
    const names = this.byRoute[route] ?? [];
    const rank = (lane: EngineLane): number =>
      lane.checkState === "available" ? 0 : lane.checkState === "unchecked" ? 1 : 2;
    return names
      .map((name) => this.lane(name))
      .filter(
        (lane) =>
          lane.breaker.state() !== "open" &&
          this.underCap(lane) &&
          lane.checkState !== "blocked" &&
          lane.checkState !== "unreachable",
      )
      .map((lane, index) => ({ lane, index }))
      .sort(
        (a, b) =>
          rank(a.lane) - rank(b.lane) ||
          b.lane.checkScore - a.lane.checkScore ||
          a.index - b.index,
      )
      .map((entry) => entry.lane);
  }

  /**
   * Engines for one call. Takes engines that are free right now (up to the
   * route's per-query count); if none is free, waits for the earliest one,
   * but never longer than maxWaitMs in total. Returns the reason when the
   * route cannot be served (every engine cooling down, capped, or busy).
   */
  async acquire(
    route: EngineRoute,
    signal?: AbortSignal,
  ): Promise<{ readonly engines: readonly string[]; readonly waitedMs: number } | { readonly unavailable: string }> {
    const wanted = Math.max(1, this.perQuery[route] ?? 1);
    const started = this.clock.now();
    for (;;) {
      const lanes = this.candidates(route);
      if (lanes.length === 0) {
        return { unavailable: this.unavailableReason(route) };
      }
      const chosen: string[] = [];
      for (const lane of lanes) {
        if (chosen.length >= wanted) break;
        if (lane.bucket.waitMs() > 0) continue;
        if (!lane.breaker.admit()) continue;
        if (!lane.bucket.tryTake()) continue;
        lane.used += 1;
        chosen.push(lane.name);
      }
      if (chosen.length > 0) return { engines: chosen, waitedMs: this.clock.now() - started };
      const soonest = Math.min(...lanes.map((lane) => lane.bucket.waitMs()));
      const waited = this.clock.now() - started;
      if (waited + soonest > this.maxWaitMs) {
        return {
          unavailable: `every ${route} engine is at its rate limit (would wait ${Math.round((waited + soonest) / 1000)} s)`,
        };
      }
      await this.clock.sleep(Math.max(soonest, 50), signal);
    }
  }

  private unavailableReason(route: EngineRoute): string {
    const names = this.byRoute[route] ?? [];
    if (names.length === 0) return `no SearXNG engine is configured for ${route}`;
    const parts = names.map((name) => {
      const lane = this.lane(name);
      if (lane.breaker.state() === "open") {
        return `${name}: cooling down until ${new Date(lane.breaker.until).toISOString()} (${lane.breaker.lastReason ?? "blocked"})`;
      }
      if (!this.underCap(lane)) return `${name}: daily cap of ${this.dailyCap} reached`;
      return `${name}: ${lane.checkState}${lane.checkDetail ? ` (${lane.checkDetail})` : ""}`;
    });
    return `no SearXNG engine can serve ${route} now — ${parts.join("; ")}`;
  }

  /** Books one call's outcome per engine: blocks, failures, clean answers. */
  report(outcomes: readonly EngineOutcome[]): void {
    for (const outcome of outcomes) {
      const lane = this.lanes.get(outcome.engine);
      if (lane === undefined) continue;
      if (outcome.failure !== undefined && BLOCK_PATTERN.test(outcome.failure)) {
        lane.breaker.block(
          outcome.failure,
          /captcha/i.test(outcome.failure) ? CAPTCHA_MINIMUM_MS : 0,
        );
        lane.bucket.setPerMinute(Math.max(this.minPerMinute, lane.bucket.perMinute / 2));
        lane.clean = 0;
      } else if (outcome.failure !== undefined) {
        lane.breaker.failure(outcome.failure);
        lane.clean = 0;
      } else {
        lane.breaker.success();
        lane.clean += 1;
        if (lane.clean >= this.cleanStreakToRaise) {
          lane.clean = 0;
          lane.bucket.setPerMinute(Math.min(this.maxPerMinute, lane.bucket.perMinute + 1));
        }
      }
    }
  }

  /** Turns one SearXNG answer into per-engine outcomes for `report`. */
  static outcomes(
    asked: readonly string[],
    hitEngines: readonly (readonly string[] | undefined)[],
    failures: readonly WebSearchEngineFailure[],
  ): EngineOutcome[] {
    const counts = new Map<string, number>();
    for (const engines of hitEngines) {
      for (const engine of engines ?? []) counts.set(engine, (counts.get(engine) ?? 0) + 1);
    }
    const failed = new Map(failures.map((failure) => [failure.engine, failure.reason]));
    return asked.map((engine) => ({
      engine,
      hits: counts.get(engine) ?? 0,
      ...(failed.has(engine) ? { failure: failed.get(engine)! } : {}),
    }));
  }

  /**
   * The launch check: every engine answers its route's known-answer queries,
   * one at a time per engine (engines in parallel), through the engine's own
   * rate limit. `ask` runs one SearXNG call restricted to one engine.
   */
  async check(
    canaries: readonly EngineCanary[],
    ask: (engine: string, canary: EngineCanary, signal?: AbortSignal) => Promise<{
      readonly urls: readonly string[];
      readonly failure?: string;
    }>,
    signal?: AbortSignal,
  ): Promise<readonly WebSourceStatus[]> {
    const routesOf = new Map<string, Set<EngineRoute>>();
    for (const [route, names] of Object.entries(this.byRoute) as [EngineRoute, readonly string[]][]) {
      for (const name of names) {
        const set = routesOf.get(name) ?? new Set<EngineRoute>();
        set.add(route);
        routesOf.set(name, set);
      }
    }
    await Promise.all(
      [...this.lanes.values()].map(async (lane) => {
        const routes = routesOf.get(lane.name) ?? new Set<EngineRoute>();
        const mine = canaries.filter((canary) => routes.has(canary.route));
        const picks = mine.length > 0 ? mine.slice(0, 2) : [];
        if (picks.length === 0) return;
        let passed = 0;
        let answered = 0;
        let lastFailure: string | undefined;
        for (const canary of picks) {
          try {
            await lane.bucket.take(signal);
            lane.used += 1;
            const answer = await ask(lane.name, canary, signal);
            if (answer.failure !== undefined) {
              lastFailure = answer.failure;
              this.report([{ engine: lane.name, hits: 0, failure: answer.failure }]);
              if (BLOCK_PATTERN.test(answer.failure)) break;
              continue;
            }
            answered += 1;
            const top = answer.urls.slice(0, 5);
            const ok = canary.expect === undefined ? top.length > 0 : top.some((url) => canary.expect!.test(url));
            if (ok) passed += 1;
            this.report([{ engine: lane.name, hits: top.length }]);
          } catch (error) {
            if (signal?.aborted) throw error;
            lastFailure = error instanceof Error ? error.message : String(error);
          }
        }
        lane.checkedAt = this.clock.now();
        lane.checkScore = passed / picks.length;
        if (passed === picks.length) {
          lane.checkState = "available";
          lane.checkDetail = undefined;
        } else if (answered > 0) {
          lane.checkState = "degraded";
          lane.checkDetail = `answered but found ${passed} of ${picks.length} known targets`;
        } else if (lastFailure !== undefined && BLOCK_PATTERN.test(lastFailure)) {
          lane.checkState = "blocked";
          lane.checkDetail = lastFailure;
        } else {
          lane.checkState = "unreachable";
          lane.checkDetail = lastFailure ?? "no answer";
        }
      }),
    );
    return this.status();
  }

  /**
   * Seeds the lanes from an earlier status table (the server's probe of the
   * same SearXNG instance), so a run whose launch check is skipped starts
   * from known engine states instead of unchecked ones. Engines the pool
   * does not schedule and unchecked entries are ignored; cool-downs are not
   * seeded (the breaker learns them from this run's own traffic).
   */
  seed(statuses: readonly WebSourceStatus[]): void {
    for (const status of statuses) {
      const lane = this.lanes.get(status.id);
      if (lane === undefined || status.state === "unchecked" || status.state === "not-configured") continue;
      lane.checkState = status.state;
      lane.checkDetail = status.detail;
      lane.checkedAt = status.checkedAt;
      lane.checkScore = status.state === "available" ? 1 : status.state === "degraded" ? 0.5 : 0;
    }
  }

  /** Per-engine state, for the run's status table and readiness. */
  status(): readonly WebSourceStatus[] {
    return [...this.lanes.values()].map((lane) => {
      const open = lane.breaker.state() === "open";
      const state: WebSourceState = open ? "blocked" : lane.checkState;
      const detail = open ? lane.breaker.lastReason : lane.checkDetail;
      return {
        id: lane.name,
        state,
        ...(detail !== undefined ? { detail } : {}),
        ...(lane.checkedAt !== undefined ? { checkedAt: lane.checkedAt } : {}),
        ...(open ? { until: lane.breaker.until } : {}),
      };
    });
  }
}

/**
 * Known-answer queries for the engine check. Two per engine are drawn from
 * its routes; the targets are stable, long-lived pages.
 */
export const DEFAULT_ENGINE_CANARIES: readonly EngineCanary[] = [
  {
    route: "web",
    query: "Attention Is All You Need",
    expect: /arxiv\.org\/(abs|pdf)\/1706\.03762|papers\.nips\.cc|proceedings\.neurips\.cc/,
  },
  { route: "web", query: "SearXNG documentation", expect: /docs\.searxng\.org/ },
  {
    route: "paper-lookup",
    query: "Deep Residual Learning for Image Recognition",
    expect: /arxiv\.org\/(abs|pdf)\/1512\.03385|openaccess\.thecvf\.com|ieeexplore\.ieee\.org/,
  },
  {
    route: "paper-lookup",
    query: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    expect: /arxiv\.org\/(abs|pdf)\/1810\.04805|aclanthology\.org/,
  },
  { route: "news", query: "science" },
  { route: "news", query: "technology" },
  { route: "paper-science", query: "graph neural networks" },
  { route: "paper-science", query: "protein structure prediction" },
];
