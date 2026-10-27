import type { JobSummary } from "@brainstorm-agentic/protocol";

export const HISTORY_PAGE_SIZE = 50;

/** Search summaries only; inspecting a history must never load every run. */
export function historyMatches(jobs: readonly JobSummary[], query: string): readonly JobSummary[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return jobs;
  return jobs.filter((job) => {
    const text = `${job.title ?? ""} ${job.topic} ${job.jobId} ${job.status}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Clamp the page after removals or a search update, and always bound the DOM. */
export function historyPage<T>(items: readonly T[], requestedPage: number) {
  const pages = Math.ceil(items.length / HISTORY_PAGE_SIZE);
  const page = Math.min(Math.max(0, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 0)), Math.max(0, pages - 1));
  const offset = page * HISTORY_PAGE_SIZE;
  return { items: items.slice(offset, offset + HISTORY_PAGE_SIZE), page, pages, start: items.length ? offset + 1 : 0, end: Math.min(offset + HISTORY_PAGE_SIZE, items.length) };
}

/** SSE snapshots allocate new objects; unchanged visible records need not rerender. */
export function sameJobSummary(left: JobSummary, right: JobSummary): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
