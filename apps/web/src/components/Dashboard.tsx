/** View 2 — the job dashboard: header, pipeline graph, and per-stage panels. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { STAGE_IDS } from "@brainstorm-agentic/protocol";
import type {
  GateAnswerRequest,
  JobDetail,
  StageActivityEntry,
  StageId,
  StageStatus,
  StageView,
} from "@brainstorm-agentic/protocol";
import {
  answerGate,
  cancelJob,
  errorMessage,
  getJob,
  jobStreamUrl,
  useServerEvents,
} from "../api";
import {
  formatClock,
  formatDuration,
  jobDot,
  pickDefaultStage,
  prefersReducedMotion,
  stageDot,
  STAGE_TITLES,
} from "../format";
import { ActivityFeed, Dot, SkeletonLines } from "./common";
import { BackIcon } from "./Icons";
import { PipelineGraph } from "./PipelineGraph";
import { ProcessInputBody } from "./panels/ProcessInputPanel";
import { DecomposeBody } from "./panels/DecomposePanel";
import { SelectPanelBody } from "./panels/SelectPanelPanel";
import { GateCard, GateDecided } from "./panels/ConfirmPanelPanel";
import { FirstPassBody } from "./panels/FirstPassPanel";
import { ReviewBody } from "./panels/ReviewPanel";
import { ProposalActions, ProposalBody } from "./panels/ProposalPanel";
import { DoneBody } from "./panels/DonePanel";

function stageOf<K extends StageId>(
  job: JobDetail,
  id: K,
): Extract<StageView, { readonly id: K }> | undefined {
  return job.stages.find((s): s is Extract<StageView, { readonly id: K }> => s.id === id);
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function StageFrame({
  title,
  status,
  startedAt,
  finishedAt,
  fallbackEnd,
  now,
  error,
  activity,
  selected,
  refCb,
  actions,
  children,
}: {
  title: string;
  status: StageStatus;
  startedAt?: number;
  finishedAt?: number;
  /** End time for frozen (cancelled/failed) stages missing finishedAt. */
  fallbackEnd: number;
  now: number;
  error?: string;
  activity?: readonly StageActivityEntry[];
  selected: boolean;
  refCb: (el: HTMLElement | null) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (status === "pending") {
    return (
      <section ref={refCb} className={`stage stage-collapsed${selected ? " stage-selected" : ""}`}>
        <span className="stage-title dim">{title}</span>
        <span className="dim small">pending</span>
      </section>
    );
  }
  const running = status === "active" || status === "suspended";
  const end = finishedAt ?? (running ? now : fallbackEnd);
  const elapsed = startedAt !== undefined ? Math.max(0, end - startedAt) : undefined;
  return (
    <section ref={refCb} className={`stage${selected ? " stage-selected" : ""}`}>
      <header className="stage-head">
        <span className="stage-title">{title}</span>
        <span className="stage-status">
          <Dot state={stageDot(status)} />
          {status}
        </span>
        <span className="stage-time">
          {startedAt !== undefined && `started ${formatClock(startedAt)}`}
          {elapsed !== undefined && ` · ${formatDuration(elapsed)}`}
        </span>
        {actions && <span className="stage-actions">{actions}</span>}
      </header>
      {error && <div className="stage-error">{error}</div>}
      <ActivityFeed entries={activity ?? []} active={status === "active"} now={now} />
      {children ??
        (status === "active" && (activity?.length ?? 0) === 0 ? (
          <SkeletonLines />
        ) : null)}
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className="dash">
      <div className="skeleton" style={{ marginTop: 48 }}>
        <div className="skeleton-line" style={{ width: "38%" }} />
        <div className="skeleton-line" style={{ width: "100%", height: 64 }} />
        <div className="skeleton-line" style={{ width: "80%" }} />
        <div className="skeleton-line" style={{ width: "62%" }} />
      </div>
    </div>
  );
}

export function Dashboard({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<StageId | null>(null);
  const [confirmCancelResume, setConfirmCancelResume] = useState(false);
  const [cancellingResume, setCancellingResume] = useState(false);
  const stageRefs = useRef(new Map<StageId, HTMLElement | null>());
  const followedOnce = useRef(false);

  useEffect(() => {
    let live = true;
    getJob(jobId)
      .then((detail) => {
        // The stream may have pushed a fresher snapshot before this resolved.
        if (live) setJob((prev) => (prev && prev.updatedAt >= detail.updatedAt ? prev : detail));
      })
      .catch((e: unknown) => {
        if (live) setLoadError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [jobId]);

  const connected = useServerEvents(jobStreamUrl(jobId), (ev) => {
    if (ev.type === "job" && ev.job.jobId === jobId) {
      setJob(ev.job);
      setLoadError(null);
    }
  });

  const activeStage: StageId = job ? pickDefaultStage(job) : "process-input";
  const selected: StageId = pinned ?? activeStage;
  const jobLoaded = job !== null;
  const terminal =
    job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled";
  const now = useNow(jobLoaded && !terminal);

  const scrollToStage = useCallback((id: StageId) => {
    stageRefs.current.get(id)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  }, []);

  // Auto-follow the active stage until the user clicks a node.
  useEffect(() => {
    if (!jobLoaded || pinned !== null) return;
    if (!followedOnce.current) {
      followedOnce.current = true;
      return;
    }
    scrollToStage(activeStage);
  }, [activeStage, pinned, jobLoaded, scrollToStage]);

  const onSelectStage = useCallback(
    (id: StageId) => {
      setPinned(id);
      scrollToStage(id);
    },
    [scrollToStage],
  );

  const onGateAnswer = useCallback(
    async (req: GateAnswerRequest) => {
      const detail = await answerGate(jobId, req);
      setJob(detail);
    },
    [jobId],
  );

  const cancelCreditWait = useCallback(async () => {
    setCancellingResume(true);
    try {
      await cancelJob(jobId);
      setJob(await getJob(jobId));
    } finally {
      setCancellingResume(false);
      setConfirmCancelResume(false);
    }
  }, [jobId]);

  if (!job) {
    if (loadError) {
      return (
        <div className="dash">
          <div className="page-error">
            <p>Could not load this job: {loadError}</p>
            <a href="#/">← back to all jobs</a>
          </div>
        </div>
      );
    }
    return <DashboardSkeleton />;
  }

  const stageMap = new Map<StageId, StageView>(job.stages.map((s) => [s.id, s]));
  const reviewStage = stageOf(job, "review-members");
  const confirmStage = stageOf(job, "confirm-panel");
  const selectStage = stageOf(job, "select-panel");
  const proposalStage = stageOf(job, "synthesize-proposal");
  const removedIds: ReadonlySet<string> = new Set(confirmStage?.gate.removedMemberIds ?? []);
  const anyStageFailed = job.stages.some((s) => s.status === "failed");
  const fallbackEnd = job.updatedAt;

  const renderBody = (id: StageId): ReactNode => {
    switch (id) {
      case "process-input": {
        const stage = stageOf(job, id);
        return stage?.output ? (
          <ProcessInputBody output={stage.output} files={stage.files} />
        ) : null;
      }
      case "decompose-experts": {
        const stage = stageOf(job, id);
        return stage?.experts ? <DecomposeBody stage={stage} /> : null;
      }
      case "select-panel": {
        const stage = stageOf(job, id);
        return stage?.panel ? <SelectPanelBody stage={stage} removedIds={removedIds} /> : null;
      }
      case "confirm-panel": {
        const stage = stageOf(job, id);
        if (!stage || stage.gate.state === "not-reached") return null;
        if (stage.gate.state === "pending") {
          return (
            <GateCard
              pendingGate={job.pendingGate}
              fallbackMembers={selectStage?.panel}
              onAnswer={onGateAnswer}
            />
          );
        }
        return <GateDecided gate={stage.gate} panel={selectStage?.panel} />;
      }
      case "first-pass": {
        const stage = stageOf(job, id);
        return stage && stage.members.length > 0 ? <FirstPassBody members={stage.members} /> : null;
      }
      case "review-members": {
        const stage = stageOf(job, id);
        return stage && (stage.members.length > 0 || stage.cursor) ? (
          <ReviewBody stage={stage} />
        ) : null;
      }
      case "synthesize-proposal": {
        const stage = stageOf(job, id);
        return stage?.proposal ? <ProposalBody proposal={stage.proposal} /> : null;
      }
      case "done": {
        const stage = stageOf(job, id);
        return stage?.summary ? <DoneBody summary={stage.summary} /> : null;
      }
    }
  };

  return (
    <div className="dash">
      <header className="dash-header">
        <a href="#/" className="ghost-btn" aria-label="back to all jobs">
          <BackIcon />
        </a>
        <h1 className="dash-title" title={job.topic}>
          {job.topic}
        </h1>
        <span className="dash-status">
          <Dot state={jobDot(job.status)} />
          {job.status}
        </span>
      </header>

      {!connected && <div className="reconnect-line">reconnecting…</div>}
      {job.status === "cancelled" && <div className="banner">cancelled</div>}
      {job.status === "credit-blocked" && job.creditBlock && (
        <div className="banner credit-banner">
          <span>
            <strong>Credit blocked.</strong>{" "}
            Automatic resume in{" "}
            {formatDuration(Math.max(0, job.creditBlock.retryAt - now))} at{" "}
            {formatClock(job.creditBlock.retryAt)}.
          </span>
          {confirmCancelResume ? (
            <span className="inline-actions">
              <span>Cancel this job and prevent resume?</span>
              <button
                type="button"
                className="btn btn-danger"
                disabled={cancellingResume}
                onClick={() => void cancelCreditWait()}
              >
                {cancellingResume ? "Cancelling…" : "Yes, cancel"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmCancelResume(false)}
              >
                Keep waiting
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmCancelResume(true)}
            >
              Cancel auto-resume
            </button>
          )}
        </div>
      )}
      {job.status === "orphaned" && (
        <div className="banner">state reconstructed from workspace files</div>
      )}
      {job.status === "failed" && job.error && !anyStageFailed && (
        <div className="banner banner-bad">{job.error}</div>
      )}

      <PipelineGraph
        stages={stageMap}
        selected={selected}
        cursor={reviewStage?.status === "active" ? reviewStage.cursor : undefined}
        onSelect={onSelectStage}
      />

      <div className="stage-list">
        {STAGE_IDS.map((id) => {
          const stage = stageMap.get(id);
          return (
            <StageFrame
              key={id}
              title={STAGE_TITLES[id]}
              status={stage?.status ?? "pending"}
              startedAt={stage?.startedAt}
              finishedAt={stage?.finishedAt}
              fallbackEnd={fallbackEnd}
              now={now}
              error={stage?.error}
              activity={stage?.activity}
              selected={selected === id}
              refCb={(el) => {
                stageRefs.current.set(id, el);
              }}
              actions={
                id === "synthesize-proposal" && proposalStage?.proposal ? (
                  <ProposalActions proposal={proposalStage.proposal} />
                ) : undefined
              }
            >
              {renderBody(id)}
            </StageFrame>
          );
        })}
      </div>
    </div>
  );
}
