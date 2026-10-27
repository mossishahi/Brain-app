/** Supreme-only, exhaustive semantic examination of an already authorized snapshot. */
import { randomUUID } from "node:crypto";

import { factConsultationSchema } from "@brainstorm-agentic/content";
import {
  addUsage,
  factBadgeHash,
  factIssuanceReason,
  type AgentExecutionContext,
  type FactConsultation,
  type FactEntry,
  type FactSubmitContext,
  type JsonObject,
  type JsonValue,
  type TokenUsage,
} from "@brainstorm-agentic/core";

export interface FactConsultationRequest {
  readonly consultation: string;
  readonly bindings: { readonly input: JsonValue; readonly files: JsonValue; readonly request: JsonObject; readonly entries: JsonValue };
  readonly execution?: AgentExecutionContext;
  readonly signal: AbortSignal;
}

export interface FactConsultationResult {
  readonly result: FactConsultation;
  readonly taskId: string;
  readonly usage?: TokenUsage;
}

export type FactConsultant = (request: FactConsultationRequest) => Promise<FactConsultationResult>;

/** Never include requester identities. Unlike public previews, evidence is not clipped. */
export function supremeFactView(entry: FactEntry): JsonObject {
  return {
    id: entry.id, status: entry.status, kind: entry.kind, claim: entry.claim,
    conditions: entry.conditions, method: entry.method, evidence: entry.evidence,
    badgeHash: factBadgeHash(entry), reason: factIssuanceReason(entry),
    ...(entry.supersededBy !== undefined ? { supersededBy: entry.supersededBy } : {}),
  };
}

/** A badge issued/explained by Supreme, without the underlying table evidence record. */
export function publicFactBadge(entry: FactEntry): JsonObject {
  return { id: entry.id, badgeHash: factBadgeHash(entry), status: entry.status,
    claim: entry.claim, conditions: entry.conditions, reason: factIssuanceReason(entry),
    ...(entry.supersededBy !== undefined ? { supersededBy: entry.supersededBy } : {}) };
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function consultSnapshot(input: {
  readonly entries: readonly FactEntry[];
  readonly request: JsonObject;
  readonly context: FactSubmitContext;
  readonly batchSize: number;
  readonly consultant: FactConsultant;
  readonly signal: AbortSignal;
}): Promise<FactConsultation & { readonly taskIds: readonly string[]; readonly usage?: TokenUsage }> {
  const size = Math.max(1, Math.floor(input.batchSize));
  const batches = Math.max(1, Math.ceil(input.entries.length / size));
  const answers: string[] = [];
  const matches: FactConsultation["matches"][number][] = [];
  const taskIds: string[] = [];
  let usage: TokenUsage | undefined;
  let approval: FactConsultation["approval"];
  for (let batch = 0; batch < batches; batch++) {
    input.signal.throwIfAborted();
    const entries = input.entries.slice(batch * size, (batch + 1) * size);
    const shown = new Set(entries.map((entry) => entry.id));
    const aliases = input.request.certifiedAliases;
    const certifiedAliases = Array.isArray(aliases) ? aliases.filter((alias) =>
      alias !== null && typeof alias === "object" && !Array.isArray(alias) &&
      typeof alias.targetId === "string" && shown.has(alias.targetId)) : undefined;
    const consulted = await bounded(input.consultant({
      consultation: randomUUID(),
      bindings: {
        input: input.context.input ?? {}, files: input.context.files ?? [],
        request: { ...input.request, ...(certifiedAliases !== undefined ? { certifiedAliases } : {}),
          batch: batch + 1, batches, exhaustive: true },
        entries: entries.map(supremeFactView),
      },
      ...(input.context.execution !== undefined ? { execution: input.context.execution } : {}),
      signal: input.signal,
    }), input.signal);
    const result = factConsultationSchema.parse(consulted.result) as FactConsultation;
    if (result.matches.some((match) => !shown.has(match.factId)) ||
      (result.approval?.targetFactId !== undefined && !shown.has(result.approval.targetFactId))) {
      throw new Error("The supreme consultation referenced an entry outside its authorized batch.");
    }
    if (new Set(result.matches.map((match) => match.factId)).size !== result.matches.length) {
      throw new Error("The supreme consultation returned contradictory duplicate matches.");
    }
    answers.push(result.answer);
    matches.push(...result.matches);
    taskIds.push(consulted.taskId);
    if (consulted.usage !== undefined) usage = usage === undefined ? consulted.usage : addUsage(usage, consulted.usage);
    // Approval is a separate, small final consultation, never a vote across batches.
    if (result.approval !== undefined && input.request.phase === "approve") {
      if (batches !== 1) throw new Error("An approval requires one complete cited/target evidence view.");
      approval = result.approval;
    }
  }
  return { answer: answers.join("\n\n"), matches, taskIds,
    ...(approval !== undefined ? { approval } : {}), ...(usage !== undefined ? { usage } : {}) };
}
