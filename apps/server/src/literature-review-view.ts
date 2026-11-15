import { literatureReviewV1Schema } from "@brainstorm-agentic/content";
import type { LiteratureReviewView } from "@brainstorm-agentic/protocol";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only submitted, schema-valid deliverables reach output panels. Drafts remain exportable. */
export function submittedLiteratureReviews(artifacts: readonly {
  readonly ref: { readonly metadata?: { readonly kind?: string } };
  readonly value: unknown;
}[]): LiteratureReviewView[] {
  const latest = new Map<string, LiteratureReviewView>();
  for (const artifact of artifacts) {
    if (artifact.ref.metadata?.kind !== "literature-review") continue;
    const value = record(artifact.value);
    const owner = record(value?.owner);
    if (!value || value.state !== "submitted" || typeof value.reviewId !== "string" ||
      typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) ||
      typeof value.inputRevision !== "string" || !owner ||
      ![owner.runId, owner.taskId, owner.nodePath, owner.role].every((part) => typeof part === "string") ||
      typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") continue;
    const parsed = literatureReviewV1Schema.safeParse(value.review);
    if (!parsed.success) continue;
    const previous = latest.get(value.reviewId);
    if (previous && previous.revision >= value.revision) continue;
    latest.set(value.reviewId, {
      reviewId: value.reviewId,
      revision: value.revision,
      state: "submitted",
      owner: {
        runId: owner.runId as string, taskId: owner.taskId as string,
        nodePath: owner.nodePath as string, role: owner.role as string,
        ...(typeof owner.agentId === "string" ? { agentId: owner.agentId } : {}),
      },
      inputRevision: value.inputRevision,
      inputRequirements: parsed.data.scope.inputRequirements,
      review: parsed.data,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
  }
  return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt || a.reviewId.localeCompare(b.reviewId));
}

/** Never attribute a critic's sources to the thinker whose work they assessed. */
export function literatureForResult(reviews: readonly LiteratureReviewView[], result: unknown): LiteratureReviewView[] {
  const value = record(result);
  if (typeof value?.taskId !== "string") return [];
  const refs = record(value.metadata)?.literatureReviewIds;
  const ids = Array.isArray(refs) ? new Set(refs.filter((id): id is string => typeof id === "string")) : undefined;
  return reviews.filter((review) => review.owner.taskId === value.taskId && (ids === undefined || ids.has(review.reviewId)));
}

export function withLiterature<T>(view: T | undefined, reviews: readonly LiteratureReviewView[]): T | undefined {
  return view === undefined ? undefined : reviews.length > 0 ? { ...view, literatureReviews: reviews } : view;
}
