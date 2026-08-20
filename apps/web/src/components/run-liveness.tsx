/**
 * The run-liveness scope: one place decides whether a run is executing, and
 * everything below it — stylesheet and components alike — reads that decision
 * instead of guessing from a stage, a step or a seat.
 *
 * Pausing a run changes exactly one field the page can see: its status. Every
 * other value keeps describing where the work STANDS, which is right — a
 * paused step really is still under review, and that is where it resumes. What
 * must change is the claim that any of it is MOVING, and that claim lives here.
 */
import { createContext, useContext, type ReactNode } from "react";

import type { JobStatus } from "@brainstorm-agentic/protocol";

import { livenessAttrs, runIsAttended, runIsLive } from "../liveness";

/**
 * The run's own status, or null outside any run. Null on purpose rather than a
 * cheerful default: a component with no run above it has nothing to claim, and
 * every question below reads a missing answer as "claim nothing".
 */
const RunStatusContext = createContext<JobStatus | null>(null);

/** Is the run this subtree belongs to executing right now? */
export function useRunLive(): boolean {
  const status = useContext(RunStatusContext);
  return status !== null && runIsLive(status);
}

/**
 * Will the server act on this run's own deadlines? Countdowns ask this rather
 * than useRunLive: a suspended run runs nothing and still auto-approves, a
 * paused one is passed over.
 */
export function useRunAttended(): boolean {
  const status = useContext(RunStatusContext);
  return status !== null && runIsAttended(status);
}

/**
 * Wraps everything that belongs to one run: the dashboard, a job card. Renders
 * the element AND supplies the flag, so the two can never drift apart — the
 * stylesheet stills the animations through `data-run-live`, components ask
 * `useRunLive()` for the decisions CSS cannot make (a ticking clock, a
 * "working now" label, a poll).
 */
export function RunScope({
  status,
  as: Tag = "div",
  className,
  children,
}: {
  readonly status: JobStatus;
  readonly as?: "div" | "li" | "section" | "article";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <RunStatusContext.Provider value={status}>
      <Tag className={className} {...livenessAttrs(status)}>
        {children}
      </Tag>
    </RunStatusContext.Provider>
  );
}
