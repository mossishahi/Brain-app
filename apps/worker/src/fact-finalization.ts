import { createHash } from "node:crypto";
import type { AgentTask, JsonObject, JsonValue } from "@brainstorm-agentic/core";

/** Hash values, not insertion order, so resume identifies the same input revision. */
export function factFinalizationHash(value: JsonValue): string {
  const canonical = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      const object = item as JsonObject;
      return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key]!)]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export interface FactFinalizationSnapshot {
  readonly epoch: number;
  readonly ideas: JsonObject;
}

export interface FactFinalizationOutputs {
  readonly bridge: JsonObject;
  readonly proposal: JsonObject;
}

export interface FactFinalizationOptions {
  /** Reuse only when both original outputs were made from this exact revision. */
  readonly initial?: FactFinalizationOutputs & { readonly epoch: number; readonly ideasHash: string };
  readonly snapshot: () => Promise<FactFinalizationSnapshot>;
  /** Wait for and merge all Revoker-directed repairs and their successful re-reviews. */
  readonly drain: () => Promise<void>;
  readonly buildTask: (input: {
    readonly stage: "bridge" | "proposal";
    readonly generation: number;
    /** Include this in task IDs: generation alone can collide after process recovery. */
    readonly revision: string;
    readonly ideas: JsonObject;
    readonly bridge?: JsonObject;
  }) => AgentTask | Promise<AgentTask>;
  /** Execute through the host's durable task journal, returning validated structured output. */
  readonly execute: (task: AgentTask, stage: "bridge" | "proposal") => Promise<JsonObject>;
  readonly signal?: AbortSignal;
}

/**
 * Never finalize a synthesis made from reasoning invalidated while its agents ran.
 * Recovery is driven by actual fact/idea changes, not by an arbitrary retry cap.
 * This function holds no fact-store write lock while models or repairs run.
 */
export async function finalizeFactOutputs(options: FactFinalizationOptions): Promise<FactFinalizationOutputs> {
  const read = async () => {
    options.signal?.throwIfAborted();
    const snapshot = await options.snapshot();
    const ideas = structuredClone(snapshot.ideas);
    return { epoch: snapshot.epoch, ideas, hash: factFinalizationHash(ideas) };
  };
  const same = (a: { epoch: number; hash: string }, b: { epoch: number; hash: string }) =>
    a.epoch === b.epoch && a.hash === b.hash;
  for (let generation = 0; ; generation++) {
    options.signal?.throwIfAborted();
    await options.drain();
    const start = await read();
    if (generation === 0 && options.initial?.epoch === start.epoch && options.initial.ideasHash === start.hash) {
      return { bridge: options.initial.bridge, proposal: options.initial.proposal };
    }
    const revision = `${start.epoch}:${start.hash}`;
    const bridgeTask = await options.buildTask({ stage: "bridge", generation, revision, ideas: start.ideas });
    options.signal?.throwIfAborted();
    const bridge = await options.execute(bridgeTask, "bridge");
    await options.drain();
    if (!same(start, await read())) continue;
    const proposalTask = await options.buildTask({ stage: "proposal", generation, revision, ideas: start.ideas, bridge });
    options.signal?.throwIfAborted();
    const proposal = await options.execute(proposalTask, "proposal");
    await options.drain();
    if (same(start, await read())) return { bridge, proposal };
  }
}
