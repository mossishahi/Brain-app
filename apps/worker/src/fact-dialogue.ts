/** One shared Supreme-owned table. Open conversations are temporary files, not facts. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { factVerdictSchema } from "@brainstorm-agentic/content";
import {
  factBadgeHash, factIdsIn, factStandingRevision, isFactId,
  type FactConsultQuery, type FactConsultation, type FactDeletion, type FactDependency,
  type FactEntry, type FactEvidenceSnapshot, type FactRequester, type FactScope, type FactSubmission,
  type FactSubmissionOutcome, type FactSubmitContext, type FactTableLimits, type FactUpdateEvent,
  type FactUpdateListener, type FactUseApproval, type FactVerdict, type JsonObject,
} from "@brainstorm-agentic/core";
import { formatFactOutcome } from "@brainstorm-agentic/host-tools";
import { consultSnapshot, supremeFactView, type FactConsultant } from "./fact-consultation.js";
import type { FactVerifier } from "./fact-table.js";
import { DEFAULT_FS_DEADLINE_MS, withFsDeadline } from "./fs-stores.js";

interface Thread {
  id: string;
  requester: FactRequester;
  claim: string;
  messages: { role: "requester" | "supreme"; text: string }[];
  matches: FactConsultation["matches"];
  revisions: Record<string, string>;
}
interface Completed {
  requester: FactRequester;
  requestHash: string;
  outcome: FactSubmissionOutcome;
}
interface Options { logPath: string; limits: FactTableLimits; now?: () => number }
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const threadId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const matchesOwner = (a: FactRequester, b: FactRequester): boolean =>
  a.taskId === b.taskId && a.role === b.role && a.agent === b.agent && a.seat === b.seat && a.step === b.step;
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const uuid = (): string => randomUUID();
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** The selected verified evidence is disclosed through Supreme, never a raw table dump. */
export function dialogueBadge(entry: FactEntry): JsonObject {
  return supremeFactView(entry);
}

export class SharedFactDialogue {
  private readonly logPath: string;
  private readonly limits: FactTableLimits;
  private readonly now: () => number;
  private readonly loaded: Promise<void>;
  private active = new Map<string, FactEntry>();
  private deleted = new Map<string, FactDeletion>();
  private withdrawals = new Map<string, FactUpdateEvent>();
  private approvals: FactUseApproval[] = [];
  private completed = new Map<string, Completed>();
  private verifier?: FactVerifier;
  private consultant?: FactConsultant;
  private listeners: FactUpdateListener[] = [];
  private mutations: Promise<unknown> = Promise.resolve();
  private diskWrites: Promise<unknown> = Promise.resolve();
  private threadWork = new Map<string, Promise<unknown>>();
  private nextFact = 1;
  private nextSubmission = 1;
  private failure?: unknown;
  private partialTail = false;

  constructor(options: Options) {
    this.logPath = options.logPath; this.limits = options.limits; this.now = options.now ?? Date.now;
    this.loaded = this.load(); this.loaded.catch(() => undefined);
  }
  attachVerifier(value: FactVerifier): void { this.verifier = value; }
  attachConsultant(value: FactConsultant): void { this.consultant = value; }
  onUpdate(value: FactUpdateListener): void { this.listeners.push(value); }
  async entries(signal?: AbortSignal): Promise<readonly FactEntry[]> {
    await (signal ? bounded(this.loaded, signal) : this.loaded); signal?.throwIfAborted(); if (this.failure) throw this.failure;
    return [...this.active.values()];
  }
  async evidence(): Promise<FactEvidenceSnapshot> {
    return { facts: await this.entries(), approvals: [...this.approvals], deletions: [...this.deleted.values()] };
  }
  async deletions(signal?: AbortSignal): Promise<readonly FactDeletion[]> { await this.entries(signal); return [...this.deleted.values()]; }
  async deletionEpoch(): Promise<number> { await this.entries(); return this.deleted.size; }
  async updateEvents(): Promise<readonly FactUpdateEvent[]> { await this.entries(); return [...this.withdrawals.values()]; }
  forTask(_taskId: string, _scope: FactScope): this { return this; }

  private signal(context: FactSubmitContext): AbortSignal {
    const ceiling = AbortSignal.timeout(Math.max(1, Math.round(this.limits.verificationMinutes * 60_000)));
    return context.signal ? AbortSignal.any([context.signal, ceiling]) : ceiling;
  }
  private async load(): Promise<void> {
    let text: string;
    try { text = await withFsDeadline(readFile(this.logPath, "utf8"), DEFAULT_FS_DEADLINE_MS, "reading shared facts"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    const lines = text.split("\n"); this.partialTail = (lines.pop() ?? "") !== "";
    const allEntries = new Map<string, FactEntry>();
    const withdrawals: { deletion: FactDeletion; entry: FactEntry; reason: string; submission: string }[] = [];
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch {
        if (!line.trim() || line.endsWith("!")) continue; // an abandoned partial append
        throw new Error("The shared fact journal contains a malformed completed record.");
      }
      const records = parsed.type === "transaction" ? parsed.records as Record<string, unknown>[] : [parsed];
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (record.type === "view-commit" || record.type === "allocation") throw new Error("A private-view fact journal cannot be resumed under the shared dialogue protocol.");
        if (record.type === "entry") {
          const entry = record.entry as FactEntry;
          if (!entry || !isFactId(entry.id) || entry.status !== "justified" || !Array.isArray(entry.history) ||
              !Array.isArray(entry.requesters) || typeof entry.claim !== "string" || typeof entry.conditions !== "string" ||
              (entry.dependencies !== undefined && !Array.isArray(entry.dependencies)) ||
              (entry.badgeHash !== undefined && entry.badgeHash !== factBadgeHash(entry))) {
            throw new Error("The shared dialogue table contains an invalid or unverified entry.");
          }
          allEntries.set(entry.id, entry);
          if (!this.deleted.has(entry.id)) this.active.set(entry.id, entry);
          this.nextFact = Math.max(this.nextFact, Number(entry.id.slice(2)) + 1);
        } else if (record.type === "deletion") {
          const deletion: FactDeletion = { id: String(record.id), seq: Number(record.seq), at: Number(record.at),
            ...(typeof record.replacedBy === "string" ? { replacedBy: record.replacedBy } : {}) };
          const entry = this.active.get(deletion.id);
          this.active.delete(deletion.id); this.deleted.set(deletion.id, deletion);
          if (entry) withdrawals.push({ deletion, entry, reason: String(record.reason ?? "The supporting fact was withdrawn."), submission: String(record.submission ?? "") });
        } else if (record.type === "approval") this.approvals.push(record.approval as FactUseApproval);
        else if (record.type === "verification-usage" && typeof record.submission === "string" && /^S:[1-9][0-9]*$/.test(record.submission)) {
          this.nextSubmission = Math.max(this.nextSubmission, Number(record.submission.slice(2)) + 1);
        } else if (record.type === "submission") {
          this.nextSubmission = Math.max(this.nextSubmission, Number(String(record.id).slice(2)) + 1);
          if (typeof record.conversationId === "string" && typeof record.requestHash === "string" && record.outcome) {
            this.completed.set(record.conversationId, { requester: record.requester as FactRequester, requestHash: record.requestHash, outcome: record.outcome as FactSubmissionOutcome });
          }
        }
      }
    }
    for (const entry of this.active.values()) this.dependencies(entry.dependencies, [...this.active.values()]);
    for (const item of withdrawals) this.withdrawals.set(item.deletion.id, {
      ...item, ...(item.deletion.replacedBy && allEntries.has(item.deletion.replacedBy) ? { replacement: allEntries.get(item.deletion.replacedBy)! } : {}),
    });
  }
  private async append(records: readonly object[]): Promise<void> {
    const work = this.diskWrites.then(async () => {
      if (this.failure) throw this.failure;
      try {
        await withFsDeadline((async () => {
          await mkdir(dirname(this.logPath), { recursive: true });
          const file = await open(this.logPath, "a", 0o600);
          try {
            await file.writeFile(`${this.partialTail ? "!\n" : ""}${JSON.stringify({ type: "transaction", records })}\n`);
            await file.sync();
          } finally { await file.close(); }
        })(), DEFAULT_FS_DEADLINE_MS, "committing shared fact ruling");
        this.partialTail = false;
      } catch (error) { this.failure = error; throw error; }
    });
    this.diskWrites = work.catch(() => undefined); await work;
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(work); this.mutations = pending.catch(() => undefined); return pending;
  }
  private threadPath(id: string): string {
    if (!threadId(id)) throw new Error("Unknown fact conversation.");
    return join(dirname(this.logPath), "fact-dialogues", `${id}.json`);
  }
  private async save(thread: Thread): Promise<void> {
    const path = this.threadPath(thread.id);
    await withFsDeadline((async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${uuid()}.tmp`;
      try { await writeFile(tmp, JSON.stringify(thread), { mode: 0o600 }); await rename(tmp, path); }
      finally { await unlink(tmp).catch(() => undefined); }
    })(), DEFAULT_FS_DEADLINE_MS, "saving open fact conversation");
  }
  private async read(id: string, requester: FactRequester): Promise<Thread> {
    const thread = JSON.parse(await withFsDeadline(readFile(this.threadPath(id), "utf8"), DEFAULT_FS_DEADLINE_MS, "reading open fact conversation")) as Thread;
    if (thread.id !== id || !thread.requester || !Array.isArray(thread.messages) || !Array.isArray(thread.matches) || !thread.revisions) throw new Error("The saved fact conversation is invalid.");
    if (!matchesOwner(thread.requester, requester)) throw new Error("This fact conversation belongs to a different requester.");
    return thread;
  }
  private async close(id: string): Promise<void> {
    await withFsDeadline(unlink(this.threadPath(id)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }), DEFAULT_FS_DEADLINE_MS, "discarding closed fact conversation");
  }
  private async scan(entries: readonly FactEntry[], request: JsonObject, context: FactSubmitContext, requesterTaskId: string): Promise<FactConsultation> {
    if (!this.consultant) throw new Error("The supreme consultation service is unavailable.");
    const result = await consultSnapshot({ entries, request: { ...request, protocol: "supreme-dialogue/v2" }, context,
      batchSize: this.limits.relatedFacts, consultant: this.consultant, signal: context.signal ?? this.signal(context) });
    await this.append([{ type: "consultation-usage", at: this.now(), requesterTaskId, taskIds: result.taskIds,
      ...(result.usage ? { usage: result.usage } : {}) }]);
    return result;
  }
  private response(thread: Thread, result: FactConsultation, entries: readonly FactEntry[]): JsonObject {
    const byId = new Map(entries.map(e => [e.id, e]));
    return { mode: "reply", conversationId: thread.id, state: "open", answer: result.answer,
      matches: result.matches.map(match => ({ ...match, badge: dialogueBadge(byId.get(match.factId)!) })),
      actions: ["close", "badge", "justify", "challenge", "clarify"] };
  }
  private async converse(thread: Thread, message: string | undefined, context: FactSubmitContext): Promise<JsonObject> {
    const entries = await this.entries(context.signal);
    const result = await this.scan(entries, { phase: "match", claim: thread.claim,
      ...(message ? { message } : {}), dialogue: json({ messages: thread.messages }).messages! }, { ...context, signal: this.signal(context) }, thread.requester.taskId);
    // A read describes one committed snapshot; unrelated writes do not restart it.
    thread.matches = result.matches;
    thread.revisions = Object.fromEntries(result.matches.map(m => [m.factId, factBadgeHash(entries.find(e => e.id === m.factId)!)]));
    if (message) thread.messages.push({ role: "requester", text: message });
    thread.messages.push({ role: "supreme", text: result.answer });
    await this.save(thread);
    return this.response(thread, result, entries);
  }

  async consult(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext): Promise<JsonObject> {
    await this.entries(context.signal);
    if (query.mode === "lookup") {
      if (!query.claim?.trim() || Object.keys(query).some(k => !["mode", "claim"].includes(k))) throw new Error("Start a fact conversation with only the claim.");
      const thread: Thread = { id: uuid(), requester, claim: query.claim, messages: [], matches: [], revisions: {} };
      await this.save(thread);
      try { return { ...await this.converse(thread, undefined, context), mode: "lookup" }; }
      catch (error) { await this.close(thread.id); throw error; }
    }
    if (query.mode === "status") return this.status(requester, query, context);
    if (query.mode === "approve") return this.approve(requester, query, context);
    if (query.mode !== "reply" || !query.conversationId || !query.action) throw new Error("Start with lookup, then reply in its fact conversation.");
    const id = query.conversationId;
    const pending = (this.threadWork.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => this.reply(requester, query, context));
    this.threadWork.set(id, pending);
    try { return await (context.signal ? bounded(pending, context.signal) : pending); }
    finally { if (this.threadWork.get(id) === pending) this.threadWork.delete(id); }
  }
  private async reply(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext): Promise<JsonObject> {
    const id = query.conversationId!;
    const done = this.completed.get(id);
    if (done && matchesOwner(done.requester, requester) && done.requestHash === digest(query)) {
      if (done.outcome.badge) {
        const current = this.active.get(done.outcome.badge.id);
        if (!current || factBadgeHash(current) !== factBadgeHash(done.outcome.badge)) {
          await this.close(id);
          return { mode: "reply", state: "closed", conversationId: id, answer: "The earlier accepted badge has since been withdrawn. Open a new conversation to check its replacement." };
        }
      }
      await this.close(id); return this.outcomeResponse(id, done.outcome);
    }
    const thread = await this.read(id, requester);
    context.signal?.throwIfAborted();
    if (query.action === "close") { await this.close(id); return { mode: "reply", conversationId: id, state: "closed", answer: "The fact conversation is closed." }; }
    if (query.action === "clarify") {
      if (!query.message?.trim()) throw new Error("Clarify needs a message.");
      return this.converse(thread, query.message, context);
    }
    if (query.action === "badge") {
      const entry = this.active.get(query.factId ?? "");
      if (!entry || query.badgeHash !== factBadgeHash(entry) || thread.revisions[entry.id] !== query.badgeHash) throw new Error("The selected badge changed or was not offered in this conversation; clarify to refresh it.");
      await this.close(id);
      return { mode: "reply", conversationId: id, state: "closed", case: "justified", badge: dialogueBadge(entry),
        answer: "Use this existing claim only under its verified conditions. Selecting it does not verify a different proposition." };
    }
    if (query.action !== "justify" && query.action !== "challenge") throw new Error("Unknown fact conversation action.");
    if (!query.claim?.trim() || !query.conditions?.trim() || !query.evidence?.trim() || !query.kind) throw new Error("Justification needs claim, conditions, evidence and kind.");
    thread.messages.push({ role: "requester", text: JSON.stringify({ action: query.action, claim: query.claim,
      conditions: query.conditions, evidence: query.evidence, kind: query.kind, dependencies: query.dependencies,
      message: query.message, step: query.step, purpose: query.purpose,
      factId: query.factId, badgeHash: query.badgeHash }) });
    await this.save(thread);
    const decision = this.queue(async () => {
      context.signal?.throwIfAborted();
      // A cancellation can return while a durable commit is already in progress.
      // Recheck the accepted decision inside the writer queue before retrying it.
      const accepted = this.completed.get(id);
      if (accepted) {
        if (!matchesOwner(accepted.requester, requester) || accepted.requestHash !== digest(query)) throw new Error("This fact conversation already closed with another accepted decision.");
        const current = accepted.outcome.badge && this.active.get(accepted.outcome.badge.id);
        if (!current || factBadgeHash(current) !== factBadgeHash(accepted.outcome.badge!)) throw new Error("The earlier accepted badge has been withdrawn; start a new conversation.");
        return accepted.outcome;
      }
      if (query.action === "challenge") {
        const entry = this.active.get(query.factId ?? "");
        if (!entry || factBadgeHash(entry) !== query.badgeHash || thread.revisions[entry.id] !== query.badgeHash) throw new Error("The challenged fact changed or was not offered; refresh the conversation first.");
      }
      return this.verifyAndCommit(requester, query, context, thread);
    });
    const outcome = await (context.signal ? bounded(decision, context.signal) : decision);
    if (outcome.badge) await this.close(id);
    else {
      thread.messages.push({ role: "supreme", text: JSON.stringify(this.outcomeResponse(id, outcome)) });
      // A ruling can introduce an incumbent absent from the initial lookup.
      // Its surviving evidence is now offered, and may be selected explicitly.
      for (const conflict of outcome.conflicts) {
        const survivor = this.active.get(conflict.entry.id);
        if (survivor && factBadgeHash(survivor) === factBadgeHash(conflict.entry)) {
          thread.revisions[survivor.id] = factBadgeHash(survivor);
          thread.matches = [...thread.matches.filter(match => match.factId !== survivor.id),
            { factId: survivor.id, relation: "conflicts", conditionsRelation: "unspecified", reason: conflict.explanation }];
        }
      }
      await this.save(thread);
    }
    return this.outcomeResponse(id, outcome);
  }
  private outcomeResponse(id: string, outcome: FactSubmissionOutcome): JsonObject {
    return { ...formatFactOutcome(outcome), mode: "reply", conversationId: id, state: outcome.badge ? "closed" : "open",
      ...(!outcome.badge ? { actions: ["close", "badge", "justify", "challenge", "clarify"],
        next: "Review the ruling and selected evidence. Supply a further justification or rebuttal in this conversation, choose an offered surviving badge under its exact conditions, or close. Withdrawn claims cannot support reasoning." } : {}),
      ...(outcome.verdict ? { ruling: { claim: outcome.verdict.claim, conditions: outcome.verdict.conditions,
        method: outcome.verdict.method, evidence: outcome.verdict.evidence, explanation: outcome.verdict.explanation } } : {}),
      ...(outcome.badge ? { badge: dialogueBadge(outcome.badge) } : {}),
      ...(outcome.conflicts.length ? { conflicts: outcome.conflicts.map(c => ({ resolution: c.resolution,
        explanation: c.explanation, entry: { ...dialogueBadge(c.entry), ...(c.deleted ? { status: "revoked" } : {}) },
        ...(c.deleted ? { deleted: true } : {}) })) } : {}) };
  }
  private dependencies(refs: readonly FactDependency[] | undefined, shown: readonly FactEntry[], excluded = new Set<string>()): readonly FactDependency[] {
    const ids = new Set<string>();
    for (const ref of refs ?? []) {
      const entry = shown.find(e => e.id === ref.id);
      if (!entry || excluded.has(ref.id) || factBadgeHash(entry) !== ref.badgeHash || ids.has(ref.id)) throw new Error("The verified proof names an unavailable, stale or duplicate supporting fact.");
      ids.add(ref.id);
    }
    return refs ?? [];
  }
  private async verifyAndCommit(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext, thread: Thread): Promise<FactSubmissionOutcome> {
    if (!this.verifier) throw new Error("The fact table's verifier is not available in this run.");
    const signal = this.signal(context);
    const entries = await this.entries(signal);
    const submission: FactSubmission = { claim: query.claim!, conditions: query.conditions!, evidence: query.evidence!, kind: query.kind!,
      ...(query.dependencies ? { dependencies: query.dependencies } : {}),
      ...(query.step !== undefined ? { step: query.step } : {}), ...(query.purpose !== undefined ? { purpose: query.purpose } : {}) };
    const dialogue = json({ originalClaim: thread.claim, messages: thread.messages });
    this.dependencies(submission.dependencies, entries);
    const scan = await this.scan(entries, json({ ...submission, phase: "match", action: query.action, dialogue, ...(query.message ? { message: query.message } : {}) }), { ...context, signal }, requester.taskId);
    const relevant = new Set(scan.matches.map(m => m.factId));
    for (const dep of submission.dependencies ?? []) relevant.add(dep.id);
    if (query.factId) relevant.add(query.factId);
    const shown = entries.filter(e => relevant.has(e.id));
    const id = `S:${this.nextSubmission++}`;
    const verification = await bounded(this.verifier({ submission: id, bindings: { input: context.input ?? {}, files: context.files ?? [],
      request: json({ ...submission, protocol: "supreme-dialogue/v2", action: query.action, ...(query.factId ? { challengedFactId: query.factId } : {}), matches: scan.matches, dialogue, ...(query.message ? { message: query.message } : {}) }),
      related: shown.map(supremeFactView) }, ...(context.execution ? { execution: context.execution } : {}), signal }), signal);
    signal.throwIfAborted();
    const verdict = factVerdictSchema.parse(verification.verdict) as FactVerdict;
    if (verdict.conflicts.some(c => !shown.some(e => e.id === c.id))) throw new Error("The verdict referenced a fact outside the verified evidence.");
    const refs = this.dependencies(verdict.dependencies, shown);
    const checkCitations = (evidence: string, dependencies: readonly FactDependency[]): void => {
      if (factIdsIn(evidence).some(id => !dependencies.some(ref => ref.id === id))) {
        throw new Error("The verified evidence cites a supporting badge without recording its exact dependency.");
      }
    };
    if (verdict.case === "justified-new" || verdict.case === "narrowed") checkCitations(verdict.evidence, refs);
    let badge: FactEntry | undefined;
    const created: FactEntry[] = [];
    const revoked = new Map<string, { reason: string; replacedBy?: string }>();
    const at = this.now();
    const make = (claim: string, conditions: string, method: FactEntry["method"], evidence: string, kind: FactEntry["kind"], dependencies: readonly FactDependency[], reason: string): FactEntry => {
      const entry: FactEntry = { id: `F:${this.nextFact++}`, status: "justified", claim, conditions, method, evidence, kind,
        dependencies, createdAt: at, updatedAt: at, history: [{ at, event: "issued", by: id, detail: reason }], requesters: [requester] };
      const hashed = { ...entry, badgeHash: factBadgeHash(entry) }; created.push(hashed); return hashed;
    };
    if (verdict.case === "justified") {
      const match = scan.matches.find(m => m.factId === verdict.existing && m.relation === "equivalent" && m.conditionsRelation === "same");
      badge = shown.find(e => e.id === verdict.existing);
      if (!badge || !match) throw new Error("Reusing a badge requires the same proposition and the same verified conditions; a derived claim needs its own checked record.");
    } else if (verdict.case === "justified-new" || verdict.case === "narrowed") {
      badge = make(verdict.claim, verdict.conditions, verdict.method, verdict.evidence, submission.kind, refs, verdict.explanation);
    }
    for (const conflict of verdict.conflicts) {
      const old = entries.find(e => e.id === conflict.id)!;
      if (conflict.resolution === "incumbent-revoked") revoked.set(old.id, { reason: conflict.explanation, ...(badge ? { replacedBy: badge.id } : {}) });
      else if (conflict.resolution === "both-narrowed") {
        const replacement = conflict.replacement;
        if (!replacement) throw new Error("Narrowing an existing fact requires a separately verified replacement claim and evidence.");
        const replacementRefs = this.dependencies(replacement.dependencies, shown);
        checkCitations(replacement.evidence, replacementRefs);
        const revised = make(replacement.claim, replacement.conditions, replacement.method, replacement.evidence, old.kind, replacementRefs, conflict.explanation);
        revoked.set(old.id, { reason: conflict.explanation, replacedBy: revised.id });
      } else if (conflict.resolution === "disputed") revoked.set(old.id, { reason: conflict.explanation });
    }
    // A result relying on an invalidated premise ceases to be justified too.
    for (;;) {
      const more = entries.filter(e => !revoked.has(e.id) && e.dependencies?.some(dep => revoked.has(dep.id)));
      if (!more.length) break;
      for (const entry of more) revoked.set(entry.id, { reason: `Supporting fact ${entry.dependencies!.filter(d => revoked.has(d.id)).map(d => d.id).join(", ")} was withdrawn. Recheck this derived claim before relying on it.` });
    }
    for (const entry of created) this.dependencies(entry.dependencies, shown, new Set(revoked.keys()));
    const next = new Map(this.active);
    for (const entry of created) next.set(entry.id, entry);
    const events: FactUpdateEvent[] = [];
    let seq = this.deleted.size;
    for (const [factId, change] of revoked) {
      const entry = next.get(factId)!; next.delete(factId);
      const deletion: FactDeletion = { id: factId, seq: ++seq, at, ...(change.replacedBy ? { replacedBy: change.replacedBy } : {}) };
      events.push({ deletion, entry, reason: change.reason, submission: id,
        ...(change.replacedBy ? { replacement: next.get(change.replacedBy)! } : {}) });
    }
    const outcome: FactSubmissionOutcome = { submission: id, case: verdict.case, verdict,
      ...(badge ? { badge } : {}), conflicts: verdict.conflicts.map(c => ({ entry: entries.find(e => e.id === c.id)!, resolution: c.resolution, explanation: c.explanation,
        ...(revoked.has(c.id) ? { deleted: true } : {}) })) };
    const requestHash = digest(query);
    // A rejected exchange that changed no facts belongs only to its open thread.
    // Keep accounting and identifier continuity without archiving its arguments.
    const audit = badge || created.length > 0 || events.length > 0
      ? { type: "submission", at, id, requester, submission, case: verdict.case, ...(badge ? { badge: badge.id } : {}),
        verdict, verifierTaskId: verification.taskId, ...(verification.usage ? { usage: verification.usage } : {}),
        ...(badge ? { conversationId: query.conversationId, requestHash, outcome } : {}) }
      : { type: "verification-usage", at, requesterTaskId: requester.taskId, verifierTaskId: verification.taskId,
        submission: id, ...(verification.usage ? { usage: verification.usage } : {}) };
    await this.append([
      ...created.map(entry => ({ type: "entry", at, entry })),
      ...events.map(event => ({ type: "deletion", ...event.deletion, reason: event.reason, submission: id })),
      audit,
    ]);
    // Publish only after the whole ruling is durably recorded.
    this.active = next;
    if (badge) this.completed.set(query.conversationId!, { requester, requestHash, outcome });
    for (const event of events) { this.deleted.set(event.deletion.id, event.deletion); this.withdrawals.set(event.deletion.id, event); }
    for (const event of events) for (const listener of this.listeners) { try { listener(event); } catch { /* durable events replay on resume */ } }
    return outcome;
  }
  private async status(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext): Promise<JsonObject> {
    const snapshot = await this.entries(context.signal);
    const deleted = new Map(this.deleted);
    const entries = snapshot.filter(e => query.ids?.includes(e.id));
    const result = await this.scan(entries, json({ mode: "status", phase: "match", ids: query.ids ?? [] }), { ...context, signal: this.signal(context) }, requester.taskId);
    return { mode: "status", answer: result.answer, entries: entries.map(dialogueBadge),
      deleted: (query.ids ?? []).filter(id => deleted.has(id)).map(id => json(deleted.get(id))),
      unknown: (query.ids ?? []).filter(id => !snapshot.some(entry => entry.id === id) && !deleted.has(id)) };
  }
  private async approve(requester: FactRequester, query: FactConsultQuery, context: FactSubmitContext): Promise<JsonObject> {
    const review = context.review; const report = query.criticId ? review?.reports[query.criticId] : undefined;
    if (!review || !report || requester.role !== "committee-chair" || review.chairTaskId !== requester.taskId || !query.factId || !query.badgeHash || !factIdsIn(report.justification).includes(query.factId)) throw new Error("Fact approval requires the actual committee task, report and cited badge.");
    const cited = this.active.get(query.factId);
    if (!cited || factBadgeHash(cited) !== query.badgeHash) throw new Error("The cited badge is unavailable or changed.");
    const result = await this.scan([cited], { phase: "approve", factId: cited.id, badgeHash: query.badgeHash,
      justification: report.justification, proposedTargetFactId: cited.id }, { ...context, signal: this.signal(context) }, requester.taskId);
    if (!result.approval || (result.approval.approved && result.approval.targetFactId !== cited.id)) throw new Error("Supreme did not return a valid badge-use decision.");
    return this.queue(async () => {
      const current = this.active.get(cited.id);
      if (!current || factStandingRevision(current) !== factStandingRevision(cited)) throw new Error("The cited badge changed during approval; check its current replacement.");
      const receipt: FactUseApproval = { id: `A:${uuid()}`, requesterTaskId: requester.taskId, reviewVersion: review.reviewVersion,
        reportHash: report.reportHash, criticId: query.criticId!, citedBadgeId: cited.id, citedBadgeHash: query.badgeHash!,
        targetBadgeId: cited.id, targetBadgeHash: factBadgeHash(cited), targetStandingRevision: factStandingRevision(cited),
        approved: result.approval!.approved, reason: result.approval!.reason };
      await this.append([{ type: "approval", at: this.now(), approval: receipt }]); this.approvals.push(receipt);
      return { mode: "approve", answer: receipt.reason, approval: json(receipt), badge: dialogueBadge(cited) };
    });
  }
}
