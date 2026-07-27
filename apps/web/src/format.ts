/**
 * Pure presentation helpers: stage labels, status lines, dots, time
 * formatting, and the client-side markdown rendering of a proposal.
 */
import type {
  JobDetail,
  JobStatus,
  JobSummary,
  ProposalView,
  StageId,
  StageStatus,
} from "@brainstorm-agentic/protocol";

/** Short labels for the pipeline graph nodes. */
export const STAGE_GRAPH_LABELS: Record<StageId, string> = {
  "process-input": "Process",
  "decompose-experts": "Decompose",
  "select-panel": "Panel",
  "confirm-panel": "Confirm",
  "first-pass": "First pass",
  "review-members": "Review",
  "bridge-audit": "Audit",
  "synthesize-proposal": "Proposal",
  done: "Done",
};

/** Full titles for the stage panels. */
export const STAGE_TITLES: Record<StageId, string> = {
  "process-input": "Process input",
  "decompose-experts": "Decompose",
  "select-panel": "Panel selection",
  "confirm-panel": "Confirm panel",
  "first-pass": "First pass",
  "review-members": "Review",
  "bridge-audit": "Integration audit",
  "synthesize-proposal": "Proposal",
  done: "Done",
};

export type DotTone = "accent" | "ok" | "warn" | "bad" | "dim";
export interface DotState {
  readonly tone: DotTone;
  readonly pulse: boolean;
}

export function jobDot(status: JobStatus): DotState {
  switch (status) {
    case "running":
      return { tone: "accent", pulse: true };
    case "suspended":
    case "credit-blocked":
      return { tone: "warn", pulse: false };
    case "completed":
      return { tone: "ok", pulse: false };
    case "failed":
      return { tone: "bad", pulse: false };
    case "orphaned":
      return { tone: "warn", pulse: false };
    case "queued":
    case "cancelled":
      return { tone: "dim", pulse: false };
  }
}

export function stageDot(status: StageStatus): DotState {
  switch (status) {
    case "active":
      return { tone: "accent", pulse: true };
    case "suspended":
    case "credit_blocked":
      return { tone: "warn", pulse: false };
    case "completed":
      return { tone: "ok", pulse: false };
    case "failed":
      return { tone: "bad", pulse: false };
    case "pending":
    case "cancelled":
      return { tone: "dim", pulse: false };
  }
}

const RUNNING_STAGE_LINES: Partial<Record<StageId, string>> = {
  "process-input": "processing input…",
  "decompose-experts": "decomposing expertise…",
  "select-panel": "selecting panel…",
  "confirm-panel": "confirming panel…",
  "first-pass": "first pass…",
  "bridge-audit": "auditing across fields…",
  "synthesize-proposal": "synthesizing proposal…",
  done: "finishing…",
};

/** The one-line status shown on landing-page job cards. */
export function jobStatusLine(job: JobSummary): string {
  switch (job.status) {
    case "queued":
      return "queued";
    case "suspended":
      return "waiting for your panel confirmation";
    case "credit-blocked": {
      const remaining = Math.max(
        0,
        (job.creditBlock?.retryAt ?? Date.now()) - Date.now(),
      );
      return `credit blocked · resumes in ${formatDuration(remaining)}`;
    }
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "orphaned":
      return "orphaned";
    case "running": {
      const active = job.progress?.activeStage;
      if (active === "review-members") {
        const c = job.progress?.reviewCursor;
        if (c) {
          return `review · member ${c.member}/${c.memberCount} · step ${c.step}/${c.stepCount} · round ${c.round}`;
        }
        return "reviewing…";
      }
      return (active && RUNNING_STAGE_LINES[active]) ?? "running…";
    }
  }
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}

/** The stage the dashboard auto-selects while the user hasn't clicked a node. */
export function pickDefaultStage(job: JobDetail): StageId {
  const first = (status: StageStatus): StageId | undefined =>
    job.stages.find((s) => s.status === status)?.id;
  const lastTouched = [...job.stages].reverse().find((s) => s.status !== "pending")?.id;
  return (
    first("active") ??
    first("suspended") ??
    first("credit_blocked") ??
    first("failed") ??
    (job.status === "completed" ? "done" : undefined) ??
    lastTouched ??
    "process-input"
  );
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "proposal";
}

const escapeCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** Client-side markdown rendering of a proposal, used by "Download .md". */
export function proposalToMarkdown(p: ProposalView): string {
  const lines: string[] = [`# ${p.title}`, "", p.framing, ""];
  const list = (title: string, items: readonly string[]) => {
    lines.push(`## ${title}`, "");
    if (items.length === 0) lines.push("_none_");
    else for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };
  list("Consensus", p.consensus);
  list("Tensions", p.tensions);
  list("Novel directions", p.novelDirections);
  lines.push("## Action items", "");
  if (p.actionItems.length === 0) {
    lines.push("_none_", "");
  } else {
    lines.push("| # | Action | Rationale |", "| --- | --- | --- |");
    for (const item of [...p.actionItems].sort((a, b) => a.priority - b.priority)) {
      lines.push(`| ${item.priority} | ${escapeCell(item.action)} | ${escapeCell(item.rationale)} |`);
    }
    lines.push("");
  }
  lines.push("## Applications", "");
  lines.push(p.applications.length ? p.applications.map((a) => `\`${a}\``).join(" · ") : "_none_");
  lines.push("");
  return lines.join("\n");
}
