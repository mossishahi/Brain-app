import { createHash } from "node:crypto";
import { literatureReviewV1Schema, literatureReviewV1JsonSchema, type LiteratureReviewV1 } from "@brainstorm-agentic/content";
import type {
  AgentExecutionContext, AgentExecutor, AgentResult, AgentTask, ArtifactStore,
  DocumentReceipt, JsonObject, JsonValue, Tool, WebAccess,
} from "@brainstorm-agentic/core";

interface Requirement { readonly id: string; readonly text: string }
export interface ReviewEnvelope {
  readonly reviewId: string;
  readonly revision: number;
  readonly state: "draft" | "submitted";
  readonly owner: { readonly runId: string; readonly taskId: string; readonly agentId?: string; readonly nodePath: string; readonly role: string };
  readonly inputRevision: string;
  readonly inputRequirements: readonly Requirement[];
  readonly review: JsonObject;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): JsonValue { return value as JsonValue; }

/** The exact bound input is the anchor; a model cannot silently replace its requirements. */
function requirements(input: JsonValue): Requirement[] {
  const value = object(input);
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const result: Requirement[] = [{ id: "input", text: text || "null" }];
  const asks = value?.requestedOutputs ?? value?.requested;
  if (Array.isArray(asks)) asks.forEach((ask, i) => {
    result.push({ id: `requested/${i + 1}`, text: typeof ask === "string" ? ask : JSON.stringify(ask) });
  });
  return result;
}

function mergeDraft(previous: JsonObject, patch: JsonObject): JsonObject {
  const next: Record<string, JsonValue> = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "works" && Array.isArray(value)) {
      const works = new Map<string, JsonValue>();
      for (const item of Array.isArray(previous.works) ? previous.works : []) {
        const id = object(item)?.id;
        if (typeof id === "string") works.set(id, item);
      }
      for (const item of value) {
        const id = object(item)?.id;
        if (typeof id !== "string" || !id.trim()) throw new Error("Each saved work needs a stable id.");
        works.set(id, item);
      }
      next.works = [...works.values()];
    } else if (object(value) && object(previous[key])) {
      next[key] = { ...object(previous[key]), ...object(value) };
    } else next[key] = value;
  }
  return next;
}

/** Per-run service. Only sources are shared; every review is owned by one trusted task. */
export class LiteratureReviewStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly artifacts: ArtifactStore, private readonly web?: WebAccess) {}

  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(fn);
    this.queues.set(key, pending);
    try { return await pending; }
    finally { if (this.queues.get(key) === pending) this.queues.delete(key); }
  }

  async latest(task: AgentTask, context: AgentExecutionContext): Promise<ReviewEnvelope[]> {
    const latest = new Map<string, ReviewEnvelope>();
    const inputRevision = hash(JSON.stringify(object(task.metadata?.literatureReview)?.input ?? null));
    for (const ref of await this.artifacts.list()) {
      if (ref.metadata?.kind !== "literature-review" || ref.metadata.taskId !== task.taskId) continue;
      const stored = await this.artifacts.get(ref.id);
      if (!stored) continue;
      const value = JSON.parse(stored.data) as ReviewEnvelope;
      if (value.inputRevision !== inputRevision || value.owner.runId !== context.runId || value.owner.taskId !== task.taskId || value.owner.agentId !== task.agentId) continue;
      const old = latest.get(value.reviewId);
      if (!old || value.revision > old.revision) latest.set(value.reviewId, value);
    }
    return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt || a.reviewId.localeCompare(b.reviewId));
  }

  private async persist(value: ReviewEnvelope): Promise<ReviewEnvelope> {
    await this.artifacts.put({
      name: `${value.owner.runId}/literature/${value.reviewId}/${value.revision}.json`,
      data: JSON.stringify(value), contentType: "application/json",
      metadata: { kind: "literature-review", reviewId: value.reviewId, revision: value.revision,
        state: value.state, taskId: value.owner.taskId, nodePath: value.owner.nodePath,
        ...(value.owner.agentId ? { agentId: value.owner.agentId } : {}) },
    });
    return value;
  }

  async begin(task: AgentTask, context: AgentExecutionContext, key = "default"): Promise<ReviewEnvelope> {
    const spec = object(task.metadata?.literatureReview);
    const input = spec?.input ?? null;
    const inputRevision = hash(JSON.stringify(input));
    const reviewId = `review-${hash(JSON.stringify([context.runId, task.taskId, task.agentId, inputRevision, key])).slice(0, 32)}`;
    return this.serial(task.taskId, async () => {
      const old = (await this.latest(task, context)).find((entry) => entry.reviewId === reviewId);
      if (old) return old;
      const inputRequirements = requirements(input);
      const now = Date.now();
      return this.persist({ reviewId, revision: 1, state: "draft",
        owner: { runId: context.runId, taskId: task.taskId, nodePath: context.nodePath,
          role: task.skills?.[0] ?? task.kind, ...(task.agentId ? { agentId: task.agentId } : {}) },
        inputRevision, inputRequirements, createdAt: now, updatedAt: now,
        review: { schemaVersion: "literature-review/v1", scope: {
          question: "", inputRequirements: json(inputRequirements), vantage: task.agentId ?? task.kind,
        }, works: [] },
      });
    });
  }

  private async provenance(review: LiteratureReviewV1, envelope: ReviewEnvelope, context: AgentExecutionContext): Promise<string[]> {
    const issues: string[] = [];
    if (JSON.stringify(review.scope.inputRequirements) !== JSON.stringify(envelope.inputRequirements)) {
      issues.push("scope.inputRequirements must exactly match the host-provided inputRequirements.");
    }
    // Generic tool registries use taskId as their agent attribution. Both variants
    // remain confined to this exact task, including a retry after process restart.
    const contexts = [
      { taskId: envelope.owner.taskId, agentId: envelope.owner.agentId ?? envelope.owner.taskId, nodePath: context.nodePath },
      { taskId: envelope.owner.taskId, agentId: envelope.owner.taskId, nodePath: context.nodePath },
    ];
    const receipts = new Map<string, DocumentReceipt>();
    for (const scope of contexts) {
      for (const receipt of await this.web?.documentReceipts?.(scope) ?? []) {
        if (receipt.taskId === envelope.owner.taskId && [envelope.owner.agentId, envelope.owner.taskId].includes(receipt.agentId)) receipts.set(receipt.receiptId, receipt);
      }
    }
    for (const work of review.works) {
      for (const evidence of work.inspected.evidence) {
        const receipt = receipts.get(evidence.receiptId);
        if (!receipt || receipt.documentId !== evidence.documentId || !receipt.segmentIds.includes(evidence.segmentId)) {
          issues.push(`${work.id}: evidence ${evidence.receiptId}/${evidence.segmentId} was not delivered to this task.`);
          continue;
        }
        const sourceKey = (source: string) => {
          const trimmed = source.trim().replace(/^doi:/i, "https://doi.org/");
          const normalized = /^10\.\d{4,9}\//.test(trimmed) ? `https://doi.org/${trimmed}` : trimmed;
          try { const url = new URL(normalized); url.hash = ""; return url.href.replace(/\/$/, ""); } catch { return normalized; }
        };
        if (![receipt.source, receipt.finalUrl].some((source) => sourceKey(source) === sourceKey(work.source.url))) {
          issues.push(`${work.id}: source.url must identify the recorded source or final URL of its document receipt.`);
        }
        const locators = receipt.locators.filter((locator) => locator.segmentId === evidence.segmentId);
        evidence.locator = locators.map((locator) => [
          locator.page !== undefined ? `page ${locator.page}` : undefined,
          locator.pageLabel ? `printed label ${locator.pageLabel}` : undefined,
          locator.heading ?? locator.sectionId,
          locator.paragraph !== undefined ? `paragraph ${locator.paragraph}` : undefined,
          `characters ${locator.start}–${locator.end}`,
        ].filter(Boolean).join(", ")).join("; ");
        if (work.source.version !== receipt.sha256 && work.source.version !== receipt.representationHash) {
          issues.push(`${work.id}: source.version must equal the delivered source sha256 or representationHash.`);
        }
      }
      const documentIds = [...new Set(work.inspected.evidence.map((entry) => entry.documentId))];
      let complete = false;
      for (const documentId of documentIds) {
        for (const scope of contexts) {
          const coverage = await this.web?.documentCoverage?.(documentId, scope);
          if (!coverage) continue;
          // Surface host-detected extraction/access limitations even if the author
          // omitted them. Complete rendition delivery never certifies a whole paper.
          work.inspected.accessLimitations = [...new Set([...work.inspected.accessLimitations, ...coverage.document.warnings])];
          if (coverage.document.contentScope === "abstract-or-landing") {
            if (work.inspected.level === "full-text") issues.push(`${work.id}: the retrieved source is an abstract/landing page; disclose abstract-only access or retrieve the paper.`);
          } else if (coverage.fullyDelivered) complete = true;
        }
      }
      if (work.inspected.level === "full-text" && !complete) issues.push(`${work.id}: full-text requires delivery of the complete source rendition; use sections/abstract/metadata and disclose remaining access limitations.`);
    }
    return issues;
  }

  async update(task: AgentTask, context: AgentExecutionContext, reviewId: string, patch: JsonObject | undefined, submit: boolean): Promise<ReviewEnvelope> {
    return this.serial(task.taskId, async () => {
      const old = (await this.latest(task, context)).find((entry) => entry.reviewId === reviewId);
      if (!old) throw new Error("Review not found for this agent task. Use begin or list; another agent's review cannot be edited.");
      let review = patch ? mergeDraft(old.review, patch) : old.review;
      if (submit) {
        const parsed = literatureReviewV1Schema.safeParse(review);
        if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
        const issues = await this.provenance(parsed.data, old, context);
        if (issues.length) throw new Error(issues.join("\n"));
        review = parsed.data as unknown as JsonObject;
      }
      const state = submit ? "submitted" : "draft";
      if (old.state === state && JSON.stringify(review) === JSON.stringify(old.review)) return old;
      return this.persist({ ...old, review, state, revision: old.revision + 1, updatedAt: Date.now() });
    });
  }

  async validate(task: AgentTask, context: AgentExecutionContext): Promise<string[]> {
    const records = await this.latest(task, context);
    const issues = records.filter((review) => review.state !== "submitted").map((review) =>
      `Finish literature_review ${review.reviewId}: save progress and submit the structured review before argument steps or the final response.`);
    if (object(task.metadata?.literatureReview)?.mode === "required" && records.length === 0) issues.push("A submitted literature_review is required before development.");
    return issues;
  }

  async restore(task: AgentTask, context: AgentExecutionContext): Promise<string> {
    const records = await this.latest(task, context);
    return [
      "Literature reviews are separate, agent-owned deliverables. Use literature_review begin/save/submit/list/read.",
      "Save incrementally after inspecting each work. The review must explain how every work relates to the original input. It is not a verified fact table.",
      "A required review, or any review you begin, must be submitted before submit_step or the final response. Inaccessible sources must be disclosed; an honestly incomplete review is allowed, unsupported claims of full-text inspection are not.",
      "The final response keeps its existing schema. The host attaches your review IDs as a bibliography. Do not copy full reviews into that response.",
      "Saved work survives retries. Read your existing review before repeating searches or analysis; continue from saved progress.",
      JSON.stringify({ inputRequirements: records[0]?.inputRequirements ?? requirements(object(task.metadata?.literatureReview)?.input ?? null),
        reviews: records.map((review) => ({ reviewId: review.reviewId, revision: review.revision, state: review.state,
          works: Array.isArray(review.review.works) ? review.review.works.map((work) => ({ id: object(work)?.id, title: object(object(work)?.source)?.title })) : [],
          synthesis: review.review.synthesis ?? null })) }),
    ].join("\n");
  }

  tool(task: AgentTask, context: AgentExecutionContext): Tool {
    return {
      definition: {
        name: "literature_review",
        description: "Persist YOUR literature-review deliverable independently of the final response. begin with a stable key (default is idempotent); save patch incrementally (works upsert by id); submit validates the whole record, input relevance and document delivery receipts. list/read recover your own progress after retries. Required fields are described by the included literature-review skill. Host owns identity/inputRequirements; never supply another agent's identity.",
        inputSchema: { type: "object", properties: {
          action: { type: "string", enum: ["begin", "save", "submit", "list", "read"] },
          key: { type: "string", description: "Stable review purpose; default for the initial review." },
          reviewId: { type: "string" },
          patch: { ...literatureReviewV1JsonSchema as JsonObject, required: [], description: "Partial review; supplied works upsert by id. All required fields must be present in the stored review at submit. Scope inputRequirements is host-owned." },
        }, required: ["action"], additionalProperties: false },
      },
      execute: async (value) => {
        try {
          const request = object(value);
          const action = request?.action;
          if (action === "begin") return { output: json(await this.begin(task, context, typeof request?.key === "string" ? request.key : "default")) };
          if (action === "list") return { output: json(await this.latest(task, context)) };
          if (typeof request?.reviewId !== "string") throw new Error("reviewId is required; obtain it with begin/list.");
          if (action === "read") {
            const review = (await this.latest(task, context)).find((entry) => entry.reviewId === request.reviewId);
            if (!review) throw new Error("Review not found for this agent task.");
            return { output: json(review) };
          }
          if (action !== "save" && action !== "submit") throw new Error("Unknown literature_review action.");
          const result = await this.update(task, context, request.reviewId, object(request.patch), action === "submit");
          return { output: json({ reviewId: result.reviewId, revision: result.revision, state: result.state, saved: true }) };
        } catch (error) {
          return { isError: true, output: { error: error instanceof Error ? error.message : String(error), saved: false } };
        }
      },
    };
  }
}

/** The same contract is injected into every provider backend, only for opted-in bundles. */
export class LiteratureReviewAgentExecutor implements AgentExecutor {
  constructor(private readonly inner: AgentExecutor, private readonly reviews: LiteratureReviewStore) {}
  async execute(task: AgentTask, context: AgentExecutionContext): Promise<AgentResult> {
    const spec = object(task.metadata?.literatureReview);
    if (!spec) return this.inner.execute(task, context);
    if (spec.mode === "required") await this.reviews.begin(task, context);
    const validate = async () => [...await context.validateDeliverables?.() ?? [], ...await this.reviews.validate(task, context)];
    const result = await this.inner.execute(task, {
      ...context, deliverableTools: [...context.deliverableTools ?? [], this.reviews.tool(task, context)],
      restoreDeliverables: async () => [await context.restoreDeliverables?.() ?? "", await this.reviews.restore(task, context)].filter(Boolean).join("\n\n"),
      validateDeliverables: validate,
      beforeToolUse: async (name) => {
        await context.beforeToolUse?.(name);
        const short = name.startsWith("mcp__") ? name.split("__").at(-1)! : name;
        if (["paper_read", "paper_search", "paper_details", "web_search", "news_search", "web_fetch", "WebSearch", "WebFetch", "webSearch", "webFetch"].includes(short)) {
          const records = await this.reviews.latest(task, context);
          // Respect a named review already in progress rather than creating a
          // second default deliverable for the same source inspection.
          if (!records.some((review) => review.state === "draft")) {
            const latest = [...records].sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)[0];
            if (latest) await this.reviews.update(task, context, latest.reviewId, undefined, false);
            else await this.reviews.begin(task, context);
          }
        }
      },
      beforeArgumentStep: async () => [...await context.beforeArgumentStep?.() ?? [], ...await this.reviews.validate(task, context)],
    });
    if (result.status !== "ok") return result;
    const issues = await validate();
    if (issues.length) return { taskId: task.taskId, status: "error", error: { name: "LiteratureReviewIncomplete", message: issues.join("\n") } };
    const records = await this.reviews.latest(task, context);
    return { ...result, metadata: { ...result.metadata, literatureReviewIds: records.map((entry) => entry.reviewId) } };
  }
}
