/** View 1 — prompt entry plus live job cards. */
import { useCallback, useEffect, useState } from "react";
import { STAGE_IDS } from "@brainstorm-agentic/protocol";
import type {
  JobDetail,
  JobSummary,
  ReadinessCheckId,
  ReadinessReport,
  ServerSettings,
  StageId,
  StageView,
} from "@brainstorm-agentic/protocol";
import {
  cacheJobs,
  cachedJobDetail,
  cachedJobs,
  cancelJob,
  diagnoseReadiness,
  blockedReadiness,
  errorMessage,
  getJob,
  getJobs,
  getReadiness,
  getSettings,
  jobsStreamUrl,
  prefetchJobDetail,
  recheckReadiness,
  resumeInterruptedJob,
  submitJob,
  trashJob,
  useServerEvents,
  pauseJob,
  resumePausedJob,
} from "../api";
import { jobDot, jobStatusLine } from "../format";
import { runIsLive } from "../liveness";
import { Dot } from "./common";
import { copyText } from "../clipboard";
import {
  CopyIcon,
  ForwardIcon,
  RedoIcon,
  PauseIcon,
  ResumeIcon,
  TrashIcon,
  ButtonSpinner,
  StopIcon,
} from "./Icons";
import { PipelineGraph } from "./PipelineGraph";
import { RunScope } from "./run-liveness";
import {
  ProviderOnboarding,
  onboardingDismissed,
  onboardingNeeded,
} from "./ProviderOnboarding";
import { SubmissionBox } from "./SubmissionBox";

function JobCard({
  job,
  onRedo,
}: {
  readonly job: JobSummary;
  /** Prefill the composer with this job's prompt and attachments. */
  readonly onRedo: (job: JobSummary) => void;
}) {
  const [confirming, setConfirming] = useState<"cancel" | "trash" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(
    () => cachedJobDetail(job.jobId) ?? null,
  );
  const [copied, setCopied] = useState(false);

  // While unrolled, keep the flow live: refresh immediately and then poll
  // lightly for runs that are still moving (SSE keeps the summary current;
  // per-stage states need the detail).
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    const load = (): void => {
      getJob(job.jobId)
        .then((fresh) => {
          if (live) setDetail(fresh);
        })
        .catch(() => undefined);
    };
    load();
    // One refresh always; the repeat only for a run that is actually moving.
    // This used to name the terminal statuses by hand and so kept polling a
    // paused run forever — five seconds of network, for ever, for a snapshot
    // that cannot change until the submitter says so. The status is in the
    // effect's deps, so a resume starts it again.
    if (!runIsLive(job.status)) {
      return () => {
        live = false;
      };
    }
    const timer = window.setInterval(load, 5_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [expanded, job.jobId, job.status]);

  const copyPrompt = async (): Promise<void> => {
    // copyText falls back to the selection path on insecure origins, where
    // this button used to do nothing at all.
    if (await copyText(job.topic)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }
  };
  const cancellable =
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "suspended" ||
    job.status === "credit-blocked" ||
    job.status === "paused" ||
    job.status === "orphaned";
  /**
   * PAUSE keeps the run; STOP ends it. Both end the worker immediately, and the
   * difference is only what the run may do afterwards — which is why a paused
   * job can still be stopped, and a stopped one can never be resumed.
   */
  const pausable =
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "suspended" ||
    job.status === "credit-blocked" ||
    job.status === "orphaned";
  // Running/queued/suspended jobs must be stopped before they can be trashed.
  const trashable =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "orphaned";
  // An interrupted job (SLURM timeout, node failure, power cut) resumes from
  // its last checkpoint with one click; a paused one continues the same way.
  const resumable = job.status === "orphaned" || job.status === "paused";

  const perform = async (
    action: () => Promise<unknown>,
    failure: string,
  ): Promise<void> => {
    try {
      await action();
      setActionError(null);
    } catch {
      setActionError(failure);
    } finally {
      setConfirming(null);
    }
  };

  /**
   * Pause needs no confirmation: it is the reversible one, and the thing it
   * costs — tasks in flight, re-executed on the resume — is the same thing an
   * interruption costs, which the run survives routinely.
   */
  const pause = async (): Promise<void> => {
    setPausing(true);
    setActionError(null);
    try {
      await pauseJob(job.jobId);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPausing(false);
    }
  };

  const resume = async (): Promise<void> => {
    setResuming(true);
    setActionError(null);
    try {
      await (job.status === "paused"
        ? resumePausedJob(job.jobId)
        : resumeInterruptedJob(job.jobId));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setResuming(false);
    }
  };

  return (
    // The card scopes one run: its embedded flow stills when that run does.
    <RunScope as="li" status={job.status} className="job-card">
      <button
        type="button"
        className={`job-card-main${expanded ? " job-expand-open" : ""}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => prefetchJobDetail(job.jobId)}
        onFocus={() => prefetchJobDetail(job.jobId)}
      >
        <span className="job-status-line">
          <Dot state={jobDot(job.status)} />
          <span>{jobStatusLine(job)}</span>
        </span>
        {/* The run's NAME: the processor's title once the process stage is
            done, the submitted text until then. The expanded prompt box
            below always keeps the original submission. */}
        <span className="job-topic">{job.title ?? job.topic}</span>
      </button>
      <a
        className="ghost-btn"
        href={`#/jobs/${encodeURIComponent(job.jobId)}`}
        aria-label={`open this run: ${job.topic}`}
        data-tooltip="open this run"
        onMouseEnter={() => prefetchJobDetail(job.jobId)}
        onFocus={() => prefetchJobDetail(job.jobId)}
      >
        <ForwardIcon size={16} />
      </a>
      {/* Redo: a fresh composer preloaded with this run's prompt and its
          original attachments — edit and launch, nothing about THIS run
          changes. */}
      <button
        type="button"
        className="ghost-btn"
        aria-label={`redo — prefill a new run with this job's prompt and attachments: ${job.topic}`}
        data-tooltip="redo — prefill a new run from this job"
        onClick={() => onRedo(job)}
      >
        <RedoIcon size={16} />
      </button>
      {confirming !== null ? (
        <div className="cancel-zone">
          <span className="cancel-question">
            {confirming === "cancel" ? "Cancel this job?" : "Move to trash?"}
          </span>
          {confirming === "cancel" ? (
            <button
              type="button"
              className="btn btn-danger btn-small"
              onClick={() =>
                void perform(() => cancelJob(job.jobId), "cancel failed")
              }
            >
              Yes, cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              onClick={() =>
                void perform(() => trashJob(job.jobId), "move to trash failed")
              }
            >
              Yes, move
            </button>
          )}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setConfirming(null)}
          >
            No
          </button>
        </div>
      ) : (
        (cancellable || trashable || resumable) && (
          <div className="cancel-zone">
            {actionError && (
              <span className="error-text">{actionError}</span>
            )}
            {resumable && (
              <button
                type="button"
                className="ghost-btn resume-btn"
                aria-label={`${
                  job.status === "paused" ? "resume paused job" : "resume interrupted job"
                } from its last checkpoint: ${job.topic}`}
                data-tooltip="resume from checkpoint"
                disabled={resuming}
                onClick={() => void resume()}
              >
                {resuming ? <ButtonSpinner /> : <ResumeIcon size={16} />}
              </button>
            )}
            {pausable && (
              <button
                type="button"
                className="ghost-btn"
                aria-label={`pause job — stops the worker and keeps the run: ${job.topic}`}
                data-tooltip="pause — resume from here later"
                disabled={pausing}
                onClick={() => void pause()}
              >
                {pausing ? <ButtonSpinner /> : <PauseIcon size={16} />}
              </button>
            )}
            {trashable && (
              <button
                type="button"
                className="ghost-btn"
                aria-label={`move job to trash: ${job.topic}`}
                onClick={() => {
                  setActionError(null);
                  setConfirming("trash");
                }}
              >
                <TrashIcon size={16} />
              </button>
            )}
            {cancellable && (
              <button
                type="button"
                className="ghost-btn"
                aria-label={`stop job — ends the run for good: ${job.topic}`}
                data-tooltip="stop — the run cannot continue afterwards"
                onClick={() => {
                  setActionError(null);
                  setConfirming("cancel");
                }}
              >
                <StopIcon size={16} />
              </button>
            )}
          </div>
        )
      )}
      {/* Always mounted so the unroll is a genuine height transition (the
          grid-rows accordion pattern); `inert` keeps the folded content out
          of the tab order and the accessibility tree. */}
      <div
        className={`job-expand-shell${expanded ? " job-expand-shell-open" : ""}`}
        inert={!expanded}
      >
        <div className="job-expand">
          <div className="job-prompt-box">
            <div className="job-prompt-text">{job.topic}</div>
            <button
              type="button"
              className="ghost-btn job-prompt-copy"
              aria-label="copy the prompt"
              onClick={() => void copyPrompt()}
            >
              {copied ? <span className="small">copied</span> : <CopyIcon />}
            </button>
          </div>
          {/* The SAME pipeline visual as the run page — one language for
              the flow everywhere. Clicking a node opens its stage page. */}
          <PipelineGraph
            stages={expandStages(detail)}
            selected={currentStage(expandStages(detail))}
            onSelect={(id) => {
              window.location.hash = `#/jobs/${encodeURIComponent(job.jobId)}/stage/${id}`;
            }}
          />
        </div>
      </div>
    </RunScope>
  );
}

/** The detail's stages as the map shape PipelineGraph consumes. */
function expandStages(
  detail: JobDetail | null,
): ReadonlyMap<StageId, StageView> {
  return new Map((detail?.stages ?? []).map((stage) => [stage.id, stage]));
}

/** The stage the run is "at": first live/failed, else last completed. */
function currentStage(stages: ReadonlyMap<StageId, StageView>): StageId {
  const live = STAGE_IDS.find((id) => {
    const status = stages.get(id)?.status;
    return status === "active" || status === "suspended" || status === "failed";
  });
  if (live) return live;
  const done = [...STAGE_IDS]
    .reverse()
    .find((id) => stages.get(id)?.status === "completed");
  return done ?? STAGE_IDS[0]!;
}

// Update notices (app releases, skills bundles) live in <UpdateToast/>,
// mounted by the app shell so they surface on every view, not just here.

export function Landing({
  onOpenSettings,
}: {
  readonly onOpenSettings: () => void;
}) {
  // Render the cached list immediately; the fetch/SSE below refresh it.
  const [jobs, setJobs] = useState<readonly JobSummary[] | null>(cachedJobs);
  const [submitError, setSubmitError] = useState<string | null>(
    null,
  );
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [onboardingHidden, setOnboardingHidden] = useState(onboardingDismissed);

  useEffect(() => {
    let live = true;
    getJobs()
      .then((list) => {
        if (live) setJobs((previous) => previous ?? list);
      })
      .catch(() => {
        if (live) setJobs((previous) => previous ?? []);
      });
    getReadiness()
      .then((report) => {
        if (live) setReadiness((previous) => previous ?? report);
      })
      .catch(() => undefined);
    getSettings()
      .then((current) => {
        if (live) setSettings(current);
      })
      .catch(() => undefined);
    const onSettingsUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ServerSettings>).detail;
      if (detail) setSettings(detail);
    };
    window.addEventListener("brain-settings-updated", onSettingsUpdated);
    return () => {
      live = false;
      window.removeEventListener("brain-settings-updated", onSettingsUpdated);
    };
  }, []);

  const connected = useServerEvents(jobsStreamUrl, (event) => {
    if (event.type === "jobs") {
      setJobs(event.jobs);
      cacheJobs(event.jobs);
    }
    if (event.type === "readiness") {
      setReadiness(event.readiness);
    }
  });

  const recheck = useCallback((checks?: readonly ReadinessCheckId[]) => {
    recheckReadiness(checks)
      .then(setReadiness)
      .catch(() => undefined);
  }, []);

  const diagnose = useCallback((check: ReadinessCheckId) => {
    diagnoseReadiness(check)
      .then(setReadiness)
      .catch(() => undefined);
  }, []);

  // A redo request riding from a job card into the composer: its prompt and
  // its original attachments, ready to edit and launch as a fresh run.
  const [prefill, setPrefill] = useState<{
    readonly topic: string;
    readonly attachmentPaths: readonly string[];
    readonly nonce: number;
  } | null>(null);

  const submit = async (
    topic: string,
    attachmentPaths: readonly string[],
    capabilityOverrides: Readonly<Record<string, boolean>>,
  ): Promise<void> => {
    setSubmitError(null);
    try {
      await submitJob(topic, attachmentPaths, capabilityOverrides);
      setJobs(await getJobs());
    } catch (error) {
      // A readiness 409 is handled by the submission box's waiting card, not as
      // an error banner. Recognised by the payload's shape, not by the prose:
      // matching the message text means any rewording of the server's sentence
      // silently turns the waiting card into an error banner, and nothing in
      // either file would show the two had drifted apart.
      if (blockedReadiness(error) === undefined) {
        setSubmitError(errorMessage(error));
      }
      throw error;
    }
  };

  const sorted = jobs
    ? [...jobs].sort(
        (left, right) => right.createdAt - left.createdAt,
      )
    : [];

  const showOnboarding =
    !onboardingHidden && settings !== null && onboardingNeeded(settings);

  return (
    <main className="landing">
      <div className="landing-column">
        <SubmissionBox
          onSubmit={submit}
          onOpenSettings={onOpenSettings}
          readiness={readiness}
          onRecheckReadiness={recheck}
          onDiagnoseReadiness={diagnose}
          {...(prefill !== null ? { prefill } : {})}
        />
        {submitError && (
          <p className="error-text submit-error">{submitError}</p>
        )}
        {!connected && (
          <div className="reconnect-line">reconnecting…</div>
        )}
        {sorted.length > 0 && (
          <ul className="job-list">
            {sorted.map((job) => (
              <JobCard
                key={job.jobId}
                job={job}
                onRedo={(target) =>
                  setPrefill({
                    topic: target.topic,
                    attachmentPaths: target.attachments ?? [],
                    nonce: Date.now(),
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
      {showOnboarding && (
        <ProviderOnboarding
          settings={settings}
          onSaved={(updated) => {
            setSettings(updated);
            window.dispatchEvent(
              new CustomEvent("brain-settings-updated", { detail: updated }),
            );
            recheck();
          }}
          onDismiss={() => setOnboardingHidden(true)}
        />
      )}
    </main>
  );
}
