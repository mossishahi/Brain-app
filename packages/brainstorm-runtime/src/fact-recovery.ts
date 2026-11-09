import { isDeepStrictEqual } from "node:util";

/** Versioned, Revoker-directed recovery. Never exposes provider thinking transcripts. */
import { type JsonObject, type JsonValue } from "@brainstorm-agentic/core";
import { recoveryText } from "./fact-recovery-text.js";
export { recoveryText } from "./fact-recovery-text.js";
import { applyChainReconsideration } from "./state.js";
import { chainBase, factUpdateDigest, parseSubscriberKey, type FactUpdateIndex } from "./fact-updates.js";

export type RecoveryChoice = JsonObject & {
  targetKey: string;
  base: { artifactHash: string };
  action: "substitute" | "redevelop" | "restart";
  steps: number[];
  sections: string[];
  rationale: string;
  replacementFactId?: string;
};

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recoveryTarget(index: FactUpdateIndex, runId: string, key: string): JsonObject {
  const parsed = parseSubscriberKey(key);
  if (parsed === undefined) throw new Error(`Unknown recovery target ${key}`);
  const value = parsed.kind === "chain" ? index.idea(runId, parsed.seat) : index.report(runId, key)?.report;
  if (value === undefined) throw new Error(`Recovery target ${key} no longer exists`);
  const clean = recoveryText(value);
  const report = parsed.kind === "chain" ? undefined : index.report(runId, key);
  return { targetKey: key, kind: parsed.kind, seat: parsed.seat,
    base: { artifactHash: factUpdateDigest(clean) },
    ...(parsed.kind === "chain" ? { idea: clean, sections: Object.keys(chainBase(value).sections as JsonObject),
      priorReviews: index.recoveryReports(runId, parsed.seat).map((entry) => ({ step: entry.step,
        phase: entry.phase, report: recoveryText(entry.report), prefix: recoveryText([...entry.prefix]) })) }
      : { report: clean, prefix: recoveryText([...(report?.prefix ?? [])]), step: parsed.step! }),
  };
}

export function validateRecoveryChoice(choice: RecoveryChoice, target: JsonObject): void {
  if (choice.targetKey !== target.targetKey || !record(choice.base) ||
      choice.base.artifactHash !== (target.base as JsonObject).artifactHash) throw new Error("Revoker plan targets a stale or unauthorized artifact");
  if (!Array.isArray(choice.steps) || !Array.isArray(choice.sections) || new Set(choice.steps).size !== choice.steps.length ||
      new Set(choice.sections).size !== choice.sections.length) throw new Error("Revoker plan repeats a step or section");
  const idea = record(target.idea) ? target.idea : undefined;
  const length = idea !== undefined && Array.isArray(idea.cot) ? idea.cot.length : 0;
  if (choice.steps.some((step) => !Number.isSafeInteger(step) || step < 1 || step > length)) throw new Error("Revoker plan names an unknown argument step");
  const sections = new Set(Array.isArray(target.sections) ? target.sections : []);
  if (choice.sections.some((section) => !sections.has(section))) throw new Error("Revoker plan names an unknown output section");
  if (choice.action === "substitute" && choice.replacementFactId === undefined) throw new Error("Badge substitution needs an explicit replacement badge");
  if (choice.action === "restart" && (idea === undefined || choice.steps.length !== length || choice.sections.length !== sections.size)) {
    throw new Error("A reasoning restart must cover the complete affected argument and its developed output");
  }
}

function replaceBadge(value: JsonValue, deleted: readonly string[], replacement: string): JsonValue {
  if (typeof value === "string") return value.replace(/\[\s*F:[1-9][0-9]*(?:\s*[,;]\s*F:[1-9][0-9]*)*\s*\]/g, (group) => group.replace(/F:[1-9][0-9]*/g, (id) => deleted.includes(id) ? replacement : id));
  if (Array.isArray(value)) return value.map((entry) => replaceBadge(entry, deleted, replacement));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceBadge(entry, deleted, replacement)]));
  return value;
}

/** Enforce the authorized edit footprint; a substitution may change badge tokens only. */
export function applyRecoveryChoice(target: JsonObject, choice: RecoveryChoice, revision: JsonObject, deleted: readonly string[]): JsonObject {
  validateRecoveryChoice(choice, target);
  if (!record(target.idea)) {
    if (choice.action === "redevelop" && revision.decision === "unchanged") throw new Error("A Revoker-directed report repair cannot be returned unchanged");
    const original = target.report!;
    const next = revision.decision === "revised" ? (revision.report ?? revision.comment) : original;
    if (choice.action === "substitute" && !isDeepStrictEqual(next, replaceBadge(original, deleted, choice.replacementFactId!))) {
      throw new Error("Badge substitution changed the review argument instead of only its verified citation");
    }
    return record(next) ? next : {};
  }
  const original = target.idea;
  if (choice.action === "redevelop" || choice.action === "restart") {
    if (revision.decision !== "revised") throw new Error("A Revoker-directed reasoning repair must deliver a revision");
    const suppliedSteps = new Set((Array.isArray(revision.steps) ? revision.steps : []).filter(record).map((step) => step.index));
    if (choice.steps.some((step) => !suppliedSteps.has(step))) throw new Error("A Revoker-directed repair must deliver every selected argument step");
  }
  const seat = String(target.seat);
  const applied = applyChainReconsideration({ ideas: { [seat]: original } }, seat, revision, "revoker-repair");
  const next = ((applied.state.ideas as JsonObject)[seat]) as JsonObject;
  const before = chainBase(original), after = chainBase(next);
  for (const index of new Set([...Object.keys(before.steps as JsonObject), ...Object.keys(after.steps as JsonObject)])) {
    if ((after.steps as JsonObject)[index] !== (before.steps as JsonObject)[index] && !choice.steps.includes(Number(index))) throw new Error(`Repair changed unauthorized step ${index}`);
  }
  for (const section of new Set([...Object.keys(before.sections as JsonObject), ...Object.keys(after.sections as JsonObject)])) {
    if ((after.sections as JsonObject)[section] !== (before.sections as JsonObject)[section] && !choice.sections.includes(section)) throw new Error(`Repair changed unauthorized section ${section}`);
  }
  if (choice.action === "restart" && (revision.decision !== "revised" || !Array.isArray(revision.steps) || revision.steps.length !== choice.steps.length)) {
    throw new Error("A reasoning restart must deliver every argument step anew");
  }
  if (choice.action === "restart" || choice.action === "redevelop") {
    const patch = record(revision.outputPatch) ? revision.outputPatch : {};
    const supplied = new Set<string>(revision.novelty !== undefined ? ["novelty"] : []);
    for (const [shape, body] of Object.entries(patch)) {
      if (shape === "requested") supplied.add("requested");
      else if (record(body)) for (const name of Object.keys(body)) supplied.add(`${shape}.${name}`);
    }
    if (choice.sections.some((section) => !supplied.has(section))) throw new Error("A reasoning repair must deliver every developed output section selected by the Revoker");
  }
  if (choice.action === "substitute") {
    const expected = replaceBadge(original, deleted, choice.replacementFactId!);
    if (!isDeepStrictEqual(next, expected)) throw new Error("Badge substitution changed reasoning or omitted a dependent citation");
  }
  return next;
}

/** Changing an earlier premise requires fresh validation of every dependent suffix step. */
export function recoveryReviewSteps(target: JsonObject, choice: RecoveryChoice, next: JsonObject): number[] {
  if (!record(target.idea) || !Array.isArray(next.cot)) return [];
  const before = chainBase(target.idea), after = chainBase(next);
  const changed = Object.keys(before.steps as JsonObject).map(Number)
    .filter((step) => (before.steps as JsonObject)[String(step)] !== (after.steps as JsonObject)[String(step)]);
  const requested = [...choice.steps, ...changed];
  // Output-only repairs can change the conclusion without changing its written steps.
  const first = requested.length ? Math.min(...requested) : 1;
  return next.cot.map((_step, index) => index + 1).filter((step) => step >= first);
}
