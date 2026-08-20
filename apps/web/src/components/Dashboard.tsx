/** View 2 — the job dashboard: header, pipeline graph, and per-stage panels. */
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import type { ReactNode } from "react";
import { STAGE_IDS } from "@brainstorm-agentic/protocol";
import type {
  GateAnswerRequest,
  JobDetail,
  StageActivityEntry,
  StageErrorView,
  StageId,
  StageStatus,
  StageView,
  TokenUsageView,
  LiveTextEntry,
} from "@brainstorm-agentic/protocol";
import {
  answerGate,
  cacheJobDetail,
  cachedJobDetail,
  cancelJob,
  errorMessage,
  getJob,
  dismissMember,
  holdGateAutoApprove,
  jobStreamUrl,
  resumeInterruptedJob,
  resumeJob,
  retryFailedJob,
  useServerEvents,
  pauseJob,
  resumePausedJob,
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
import { runIsLive } from "../liveness";
import { ActivityFeed, Dot, SkeletonLines, TokenChip } from "./common";
import {
  BackIcon,
  ChevronIcon,
  ForwardIcon,
  PauseIcon,
  ResumeIcon,
  ButtonSpinner,
  StopIcon,
} from "./Icons";
import { PipelineGraph } from "./PipelineGraph";
import { RunScope, useRunLive } from "./run-liveness";
import { SendDiagnostics } from "./SendDiagnostics";
import {
  ClassificationDecided,
  ClassificationGateCard,
  ProcessInputBody,
} from "./panels/ProcessInputPanel";
import { DecomposeBody } from "./panels/DecomposePanel";
import { SelectPanelBody } from "./panels/SelectPanelPanel";
import { GateCard, GateDecided } from "./panels/ConfirmPanelPanel";
import { applyLiveEntries, type LiveThread } from "./live-threads";
import { FirstPassBody } from "./panels/FirstPassPanel";
import { ReviewStagePanels } from "./panels/ReviewPanel";
import { BridgeAuditBody } from "./panels/BridgeAuditPanel";
import { ProposalActions, ProposalBody } from "./panels/ProposalPanel";
import { DoneBody } from "./panels/DonePanel";
import { ToolUsagePanel } from "./panels/ToolUsagePanel";

function stageOf<K extends StageId>(
  job: JobDetail,
  id: K,
): Extract<StageView, { readonly id: K }> | undefined {
  return job.stages.find((s): s is Extract<StageView, { readonly id: K }> => s.id === id);
}

/**
 * The dashboard frame with NO run inside it — the loading skeleton and the
 * load error. Named, because the run's own frame is a <RunScope>, and a bare
 * div carrying the dash class would be a run page that silently lost its
 * liveness scope; test/liveness-wiring.test.ts forbids that literal.
 */
const NO_RUN_PAGE = "dash";

/** One shared empty map, so a stopped run re-renders nothing per frame. */
const NO_LIVE_THREADS: ReadonlyMap<string, LiveThread> = new Map();

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

/**
 * The stage's failure record: every located failure of the current attempt,
 * oldest first — a parallel stage can fail in several places while the rest
 * keeps working, so no failure may replace an earlier one. Older snapshots
 * (and stages without located failures) fall back to the single message.
 */
function StageErrors({
  errors,
  error,
}: {
  errors?: readonly StageErrorView[];
  error?: string;
}) {
  if (errors === undefined || errors.length === 0) {
    return error ? <div className="stage-error">{error}</div> : null;
  }
  return (
    <div className="stage-error" role="alert">
      {errors.map((entry, index) => (
        <div key={index} className="stage-error-row" title={entry.path}>
          <span className="stage-error-meta">
            {entry.at !== undefined && (
              <span className="stage-error-when">{formatClock(entry.at)}</span>
            )}
            {entry.where !== undefined && (
              <span className="stage-error-where">{entry.where}</span>
            )}
          </span>
          <div className="stage-error-message">{entry.message}</div>
        </div>
      ))}
    </div>
  );
}

function StageFrame({
  id,
  title,
  status,
  startedAt,
  finishedAt,
  fallbackEnd,
  now,
  error,
  errors,
  activity,
  usage,
  selected,
  expanded,
  onToggle,
  refCb,
  actions,
  children,
}: {
  id: StageId;
  title: string;
  status: StageStatus;
  startedAt?: number;
  finishedAt?: number;
  /** End time for frozen (cancelled/failed) stages missing finishedAt. */
  fallbackEnd: number;
  now: number;
  error?: string;
  errors?: readonly StageErrorView[];
  activity?: readonly StageActivityEntry[];
  usage?: TokenUsageView;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  refCb: (el: HTMLElement | null) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  // A stage describes where the work stands; only the run knows whether it is
  // moving. Both are needed here: an "active" stage on a paused run keeps its
  // status word and loses its clock.
  const live = useRunLive();
  if (status === "pending") {
    return (
      <section ref={refCb} className={`stage stage-collapsed${selected ? " stage-selected" : ""}`}>
        <span className="stage-title dim">{title}</span>
        <span className="dim small">pending</span>
      </section>
    );
  }
  const running = (status === "active" || status === "suspended") && live;
  const end = finishedAt ?? (running ? now : fallbackEnd);
  const elapsed = startedAt !== undefined ? Math.max(0, end - startedAt) : undefined;
  const bodyId = `stage-body-${id}`;
  return (
    <section ref={refCb} className={`stage${selected ? " stage-selected" : ""}`}>
      <header
        className={`stage-head${expanded ? "" : " stage-head-collapsed"}`}
        onClick={(event) => {
          // The header is a convenience toggle; its own controls must not fold
          // the panel when clicked (the chevron button handles itself).
          if ((event.target as HTMLElement).closest("button, a")) return;
          onToggle();
        }}
      >
        <button
          type="button"
          className="stage-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${expanded ? "collapse" : "expand"} ${title} panel`}
          onClick={onToggle}
        >
          <ChevronIcon />
        </button>
        <span className="stage-title">{title}</span>
        <span className="stage-status">
          <Dot state={stageDot(status)} />
          {status}
        </span>
        <span className="stage-time">
          {startedAt !== undefined && `started ${formatClock(startedAt)}`}
          {elapsed !== undefined && ` · ${formatDuration(elapsed)}`}
        </span>
        {usage && <TokenChip usage={usage} />}
        {actions && <span className="stage-actions">{actions}</span>}
      </header>
      <div id={bodyId}>
        {expanded && (
          <>
            <StageErrors errors={errors} error={error} />
            <ActivityFeed entries={activity ?? []} active={status === "active" && live} now={now} />
            {children ??
              (status === "active" && live && (activity?.length ?? 0) === 0 ? (
                <SkeletonLines />
              ) : null)}
          </>
        )}
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className={NO_RUN_PAGE}>
      <div className="skeleton" style={{ marginTop: 48 }}>
        <div className="skeleton-line" style={{ width: "38%" }} />
        <div className="skeleton-line" style={{ width: "100%", height: 64 }} />
        <div className="skeleton-line" style={{ width: "80%" }} />
        <div className="skeleton-line" style={{ width: "62%" }} />
      </div>
    </div>
  );
}

/**
 * Pausing, resuming and stopping the run you are watching.
 *
 * The three answer different questions and are deliberately not one control:
 * PAUSE keeps the run (its worker ends, its checkpoint stands, and nothing
 * automatic picks it up until you say so), RESUME continues from that
 * checkpoint, and STOP ends it for good — which is why only stop asks first.
 *
 * What pause costs is what any interruption costs: tasks in flight are
 * re-executed on the resume, and everything journalled replays for free.
 */
function useRunControl(job: JobDetail | null, jobId: string) {
  const [busy, setBusy] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = job?.status;
  const live =
    status === "queued" ||
    status === "running" ||
    status === "suspended" ||
    status === "credit-blocked" ||
    status === "orphaned";
  const act = async (action: () => Promise<unknown>, failure: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(`${failure}: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
      setConfirmingStop(false);
    }
  };
  return {
    busy,
    error,
    confirmingStop,
    pausable: live,
    resumable: status === "paused" || status === "orphaned",
    // A paused run can still be stopped: pause keeps it, stop ends it.
    stoppable: live || status === "paused",
    pause: () => act(() => pauseJob(jobId), "could not pause the run"),
    resume: () =>
      act(
        () => (status === "paused" ? resumePausedJob(jobId) : resumeInterruptedJob(jobId)),
        "could not resume the run",
      ),
    askToStop: () => {
      setError(null);
      setConfirmingStop(true);
    },
    cancelStop: () => setConfirmingStop(false),
    stop: () => act(() => cancelJob(jobId), "could not stop the run"),
  };
}

export function Dashboard({
  jobId,
  initialStage,
}: {
  jobId: string;
  /** Deep-linked stage page (#/jobs/<id>/stage/<stageId>), when given. */
  initialStage?: string;
}) {
  // Start from the cached/prefetched snapshot so navigation paints instantly.
  const [job, setJob] = useState<JobDetail | null>(
    () => cachedJobDetail(jobId) ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<StageId | null>(() =>
    initialStage !== undefined &&
    (STAGE_IDS as readonly string[]).includes(initialStage)
      ? (initialStage as StageId)
      : null,
  );
  // Stages fold by id; the set starts empty so every panel opens expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<StageId>>(() => new Set());
  const [confirmCancelResume, setConfirmCancelResume] = useState(false);
  const [cancellingResume, setCancellingResume] = useState(false);
  const [resumingNow, setResumingNow] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
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

  /**
   * What the models are saying right now, per task, for the places that would
   * otherwise say "thinking". Frames carry only new characters, so this appends;
   * a thread ENDS when its task's real output exists, and then it is deleted —
   * the output is what the page shows from that moment on.
   *
   * Never persisted, never cached with the job detail: it is the wait, not the
   * work.
   */
  const [live, setLive] = useState<ReadonlyMap<string, LiveThread>>(new Map());
  const connected = useServerEvents(jobStreamUrl(jobId), (ev) => {
    if (ev.type === "job" && ev.job.jobId === jobId) {
      setJob(ev.job);
      cacheJobDetail(ev.job);
      setLoadError(null);
    }
    if (ev.type === "live" && ev.jobId === jobId) {
      setLive((previous) => applyLiveEntries(previous, ev.entries));
    }
  });

  /**
   * Streamed text is liveness in data form: it exists only while an agent is
   * mid-thought. The moment the run stops, the threads standing in the page are
   * the last words of a worker that no longer exists — they are dropped, and
   * the place they held goes back to the output that will replace them on the
   * resume. Derived rather than cleared, so a frame arriving a beat after the
   * pause cannot put them back.
   */
  const liveNow = job !== null && runIsLive(job.status) ? live : NO_LIVE_THREADS;

  /**
   * Live threads addressed by what the page is showing: a first-pass card is a
   * SEAT thinking about its own idea; a review card is a step being worked on by
   * several agents at once, so those group by the seat under review.
   */
  const liveByThinker = useMemo(() => {
    const out = new Map<string, string>();
    for (const [id, thread] of liveNow) {
      if (thread.role !== "Thinker" || thread.actorId === undefined) continue;
      if (!id.includes("first-pass")) continue;
      out.set(thread.actorId, thread.text);
    }
    return out;
  }, [liveNow]);
  const liveByReviewedSeat = useMemo(() => {
    const out = new Map<string, LiveThread[]>();
    for (const [id, thread] of liveNow) {
      if (thread.seatId === undefined || id.includes("first-pass")) continue;
      const list = out.get(thread.seatId) ?? [];
      list.push(thread);
      out.set(thread.seatId, list);
    }
    return out;
  }, [liveNow]);

  const runControl = useRunControl(job, jobId);

  const activeStage: StageId = job ? pickDefaultStage(job) : "process-input";
  const selected: StageId = pinned ?? activeStage;
  const jobLoaded = job !== null;
  const terminal =
    job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled";
  const now = useNow(jobLoaded && !terminal);

  // Stages render as side-by-side PAGES; the pipeline graph above is the
  // navigation spine (auto-following the active stage until the user pins
  // one). The slide direction is decided ONCE per page turn and stays
  // pinned to that selection: recomputing it per render flipped the
  // animation class back to "forward" on the next clock tick after a
  // backward turn, and changing an animation class on a mounted element
  // restarts the animation — the page visibly loaded twice.
  const selectedIndex = Math.max(0, STAGE_IDS.indexOf(selected));
  const transitionRef = useRef<{
    index: number;
    direction: "forward" | "backward";
  }>({ index: selectedIndex, direction: "forward" });
  if (transitionRef.current.index !== selectedIndex) {
    transitionRef.current = {
      index: selectedIndex,
      direction:
        selectedIndex > transitionRef.current.index ? "forward" : "backward",
    };
  }
  const slideDirection = transitionRef.current.direction;

  const toggleStage = useCallback((id: StageId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onSelectStage = useCallback((id: StageId) => {
    setPinned(id);
    // Selecting a node in the pipeline graph turns its page — and lands it
    // unfolded, whatever its previous fold state was.
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const onGateAnswer = useCallback(
    async (req: GateAnswerRequest) => {
      const detail = await answerGate(jobId, req);
      setJob(detail);
    },
    [jobId],
  );

  const onGateHold = useCallback(() => {
    holdGateAutoApprove(jobId)
      .then(setJob)
      .catch(() => undefined);
  }, [jobId]);

  const onDismissMember = useCallback(
    async (memberId: string) => {
      // Errors propagate to the seat's own control, which shows them in place —
      // a 409 here is a real answer ("that would leave too few seats"), not a
      // glitch to swallow.
      setJob(await dismissMember(jobId, memberId));
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

  const resumeCreditBlocked = useCallback(async () => {
    setResumingNow(true);
    setResumeError(null);
    try {
      await resumeJob(jobId);
      setJob(await getJob(jobId));
    } catch (error) {
      setResumeError(errorMessage(error));
    } finally {
      setResumingNow(false);
    }
  }, [jobId]);

  const resumeInterrupted = useCallback(async () => {
    setResumingNow(true);
    setResumeError(null);
    try {
      await resumeInterruptedJob(jobId);
      setJob(await getJob(jobId));
    } catch (error) {
      setResumeError(errorMessage(error));
    } finally {
      setResumingNow(false);
    }
  }, [jobId]);

  const retryFailed = useCallback(async () => {
    setResumingNow(true);
    setResumeError(null);
    try {
      await retryFailedJob(jobId);
      setJob(await getJob(jobId));
    } catch (error) {
      setResumeError(errorMessage(error));
    } finally {
      setResumingNow(false);
    }
  }, [jobId]);

  if (!job) {
    if (loadError) {
      return (
        <div className={NO_RUN_PAGE}>
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
  /**
   * A seat can only be dismissed while the run still has work ahead of it. The
   * server enforces this too (and refuses to leave fewer than two seats); the
   * check here is so a settled or trashed run simply shows no control.
   */
  const dismissable =
    job.trashedAt === undefined &&
    (job.status === "queued" ||
      job.status === "running" ||
      job.status === "suspended" ||
      job.status === "credit-blocked" ||
      job.status === "orphaned");
  const fallbackEnd = job.updatedAt;

  const renderBody = (id: StageId): ReactNode => {
    switch (id) {
      case "process-input": {
        const stage = stageOf(job, id);
        if (!stage?.output && !stage?.classification) return null;
        const classificationPending = stage.classification?.gate.state === "pending";
        return (
          <div>
            {/* The classification confirmation rides on this stage: the gate
                card while pending, the decided line afterwards. */}
            {classificationPending && (
              <ClassificationGateCard
                pendingGate={job.pendingGate}
                onAnswer={onGateAnswer}
                onHold={onGateHold}
              />
            )}
            {!classificationPending && stage.classification && (
              <ClassificationDecided classification={stage.classification} />
            )}
            {stage.output && (
              <ProcessInputBody output={stage.output} files={stage.files} />
            )}
          </div>
        );
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
              onHold={onGateHold}
            />
          );
        }
        return <GateDecided gate={stage.gate} panel={selectStage?.panel} />;
      }
      case "first-pass": {
        const stage = stageOf(job, id);
        return stage && stage.members.length > 0 ? (
          <FirstPassBody members={stage.members} live={liveByThinker} />
        ) : null;
      }
      case "review-members":
        // The review stage renders as two detached panels through
        // ReviewStagePanels in the pager below, not through this body switch.
        return null;
      case "bridge-audit": {
        const stage = stageOf(job, id);
        return stage?.bridge ? <BridgeAuditBody stage={stage} /> : null;
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
    // Everything about this run hangs off one scope: the stylesheet stills its
    // animations through data-run-live, components ask useRunLive().
    <RunScope status={job.status} className="dash">
      {/* The state strip renders ONLY for attention states — amber shimmer
          while waiting for the queue, red when failed/interrupted — so a
          retry is VISIBLE the moment the server accepts it. Healthy states
          (running, completed, cancelled) draw no line: the status dot in the
          header already says so, and a permanent colored bar is noise. */}
      {(job.status === "queued" ||
        job.status === "suspended" ||
        job.status === "credit-blocked" ||
        job.status === "failed" ||
        job.status === "orphaned") && (
        <div
          className={`job-state-strip job-state-strip-${job.status}`}
          role="status"
          aria-label={`job status: ${job.status}`}
        />
      )}
      <header className="dash-header">
        <a href="#/" className="ghost-btn" aria-label="back to all jobs">
          <BackIcon />
        </a>
        <h1 className="dash-title" title={job.topic}>
          {job.topic}
        </h1>
        {job.contentBundle && (
          <span
            className="dash-bundle"
            title={`This run pinned ${job.contentBundle.id}@${job.contentBundle.version} — the exact skill/workflow version it executed`}
          >
            skills v{job.contentBundle.version}
          </span>
        )}
        <span className="dash-status">
          <Dot state={jobDot(job.status)} />
          {job.status}
        </span>
        {/* Controlling the run from where it is watched. Pause keeps it and
            stops the worker; stop ends it for good and asks first, because it
            cannot be undone. */}
        {job.trashedAt === undefined && (
          <span className="dash-actions">
            {runControl.pausable && (
              <button
                type="button"
                className="ghost-btn"
                aria-label="pause this run — stops its worker and keeps the run"
                data-tooltip="pause — resume from here later"
                disabled={runControl.busy}
                onClick={() => void runControl.pause()}
              >
                {runControl.busy ? <ButtonSpinner /> : <PauseIcon size={16} />}
              </button>
            )}
            {runControl.resumable && (
              <button
                type="button"
                className="ghost-btn"
                aria-label="resume this run from its last checkpoint"
                data-tooltip="resume from checkpoint"
                disabled={runControl.busy}
                onClick={() => void runControl.resume()}
              >
                {runControl.busy ? <ButtonSpinner /> : <ResumeIcon size={16} />}
              </button>
            )}
            {runControl.stoppable && (
              <button
                type="button"
                className="ghost-btn"
                aria-label="stop this run — it cannot continue afterwards"
                data-tooltip="stop — the run cannot continue afterwards"
                disabled={runControl.busy}
                onClick={() => runControl.askToStop()}
              >
                <StopIcon size={16} />
              </button>
            )}
          </span>
        )}
      </header>
      {runControl.confirmingStop && (
        <div className="banner confirm-banner">
          <span>
            <strong>Stop this run?</strong> Its worker ends now and it cannot be
            continued — pause instead if you mean to come back to it.
          </span>
          <span className="confirm-actions">
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={runControl.busy}
              onClick={() => void runControl.stop()}
            >
              Stop the run
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={runControl.busy}
              onClick={() => runControl.cancelStop()}
            >
              Keep it
            </button>
          </span>
        </div>
      )}
      {runControl.error !== null && (
        <div className="banner banner-bad">{runControl.error}</div>
      )}

      {!connected && <div className="reconnect-line">reconnecting…</div>}
      {job.trashedAt !== undefined && (
        <div className="banner">in trash — view-only; files remain on disk</div>
      )}
      {job.status === "cancelled" && <div className="banner">cancelled</div>}
      {job.status === "credit-blocked" && job.creditBlock && (
        <div className="banner credit-banner">
          <span>
            <strong>Credit blocked.</strong>{" "}
            {job.creditBlock.retryAt !== undefined ? (
              <>
                Automatic resume in{" "}
                {formatDuration(Math.max(0, job.creditBlock.retryAt - now))} at{" "}
                {formatClock(job.creditBlock.retryAt)}.
              </>
            ) : (
              <>
                The provider announced no reset time — top up your credits,
                then resume.
              </>
            )}
            {resumeError && <> Resume failed: {resumeError}.</>}
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
            <span className="inline-actions">
              <button
                type="button"
                className="btn"
                disabled={resumingNow}
                onClick={() => void resumeCreditBlocked()}
              >
                {resumingNow ? "Resuming…" : "Resume now"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmCancelResume(true)}
              >
                {job.creditBlock.retryAt !== undefined
                  ? "Cancel auto-resume"
                  : "Cancel job"}
              </button>
            </span>
          )}
        </div>
      )}
      {job.status === "orphaned" && (
        <div className="banner credit-banner">
          <span>
            <strong>Interrupted.</strong> The process is gone (job timeout,
            node failure, or shutdown) but its checkpoints are intact — the
            run can continue from the exact point it stopped.
            {resumeError && <> Resume failed: {resumeError}.</>}
          </span>
          <button
            type="button"
            className="btn"
            disabled={resumingNow}
            onClick={() => void resumeInterrupted()}
          >
            {resumingNow ? "Resuming…" : "Resume from checkpoint"}
          </button>
        </div>
      )}
      {job.status === "failed" && job.error && !anyStageFailed && (
        <div className="banner banner-bad">{job.error}</div>
      )}
      {job.status === "failed" && (
        <div className="banner credit-banner">
          <span>
            <strong>Failed.</strong> The checkpoints up to the failed task are
            intact — a retry re-runs only the task that failed and continues
            from there, never repeating completed work.
            {resumeError && <> Retry failed: {resumeError}.</>}
          </span>
          <button
            type="button"
            className="btn"
            disabled={resumingNow}
            onClick={() => void retryFailed()}
          >
            {resumingNow ? "Retrying…" : "Retry from checkpoint"}
          </button>
          <SendDiagnostics jobId={jobId} />
        </div>
      )}

      <div className="graph-nav-row">
        <button
          type="button"
          className="ghost-btn graph-nav"
          aria-label="previous stage"
          disabled={selectedIndex === 0}
          onClick={() => onSelectStage(STAGE_IDS[selectedIndex - 1]!)}
        >
          <BackIcon size={16} />
        </button>
        <PipelineGraph
          stages={stageMap}
          selected={selected}
          cursor={reviewStage?.status === "active" ? job.progress?.review : undefined}
          onSelect={onSelectStage}
        />
        <button
          type="button"
          className="ghost-btn graph-nav"
          aria-label="next stage"
          disabled={selectedIndex === STAGE_IDS.length - 1}
          onClick={() => onSelectStage(STAGE_IDS[selectedIndex + 1]!)}
        >
          <ForwardIcon size={16} />
        </button>
      </div>

      {(() => {
        const stage = stageMap.get(selected);
        const frame = (children: ReactNode) => (
          <StageFrame
            id={selected}
            title={STAGE_TITLES[selected]}
            status={stage?.status ?? "pending"}
            startedAt={stage?.startedAt}
            finishedAt={stage?.finishedAt}
            fallbackEnd={fallbackEnd}
            now={now}
            error={stage?.error}
            errors={stage?.errors}
            activity={stage?.activity}
            usage={stage?.usage}
            selected={false}
            expanded={!collapsed.has(selected)}
            onToggle={() => toggleStage(selected)}
            refCb={() => undefined}
            actions={
              selected === "synthesize-proposal" && proposalStage?.proposal ? (
                <ProposalActions proposal={proposalStage.proposal} />
              ) : undefined
            }
          >
            {children}
          </StageFrame>
        );
        return (
          <div className="stage-pager">
            <div
              key={selected}
              className={`stage-page stage-page-${slideDirection}`}
            >
              {selected === "review-members" && reviewStage && reviewStage.members.length > 0 ? (
                // The review stage splits into two detached panels (grid +
                // walk inspector) with the page background visible between
                // them; the first-pass stage seeds the inspector's change
                // tracking so every diff reaches back to the original chain.
                <ReviewStagePanels
                  stage={reviewStage}
                  live={liveByReviewedSeat}
                  firstPass={stageOf(job, "first-pass")}
                  expanded={!collapsed.has(selected)}
                  frame={frame}
                  topic={job.topic}
                  {...(dismissable ? { onDismiss: onDismissMember } : {})}
                />
              ) : (
                frame(renderBody(selected))
              )}
              {/*
                The capability & tool usage receipt: one page, the last one, and
                below the stage frame rather than inside it. A run that failed,
                was cancelled, or credit-blocked never reaches a completed Done
                stage, and a pending frame renders no body at all — so putting
                the receipt in that body would hide it from exactly the runs whose
                agents are most likely to have been missing something.
              */}
              {selected === "done" && (
                <ToolUsagePanel
                  jobId={jobId}
                  updatedAt={job.updatedAt}
                  active={job.status === "running"}
                />
              )}
            </div>
            <div className="stage-pager-nav">
              <button
                type="button"
                className="stage-pager-btn"
                disabled={selectedIndex === 0}
                onClick={() => onSelectStage(STAGE_IDS[selectedIndex - 1]!)}
              >
                ← {selectedIndex > 0 ? STAGE_TITLES[STAGE_IDS[selectedIndex - 1]!] : ""}
              </button>
              <span className="dim small">
                {selectedIndex + 1} / {STAGE_IDS.length}
              </span>
              <button
                type="button"
                className="stage-pager-btn"
                disabled={selectedIndex === STAGE_IDS.length - 1}
                onClick={() => onSelectStage(STAGE_IDS[selectedIndex + 1]!)}
              >
                {selectedIndex < STAGE_IDS.length - 1
                  ? STAGE_TITLES[STAGE_IDS[selectedIndex + 1]!]
                  : ""}{" "}
                →
              </button>
            </div>
          </div>
        );
      })()}

    </RunScope>
  );
}
