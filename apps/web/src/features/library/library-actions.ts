import type { JobSummary } from "@brainstorm-agentic/protocol";

export function libraryActions(job: Pick<JobSummary, "status" | "trashedAt">, readOnly = false) {
  if (readOnly || job.trashedAt !== undefined) return { pause: false, resume: false, stop: false, retry: false, trash: false, download: false };
  const status = job.status;
  return {
    pause: ["queued", "running", "suspended", "credit-blocked", "orphaned"].includes(status),
    resume: ["paused", "orphaned", "credit-blocked"].includes(status),
    stop: ["queued", "running", "suspended", "credit-blocked", "paused", "orphaned"].includes(status),
    retry: status === "failed",
    trash: ["completed", "failed", "cancelled", "orphaned"].includes(status),
    download: status !== "queued",
  };
}
