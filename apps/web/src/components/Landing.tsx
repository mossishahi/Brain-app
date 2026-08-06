/** View 1 — prompt entry plus live job cards. */
import { useCallback, useEffect, useState } from "react";
import type {
  HealthResponse,
  JobSummary,
  ReadinessCheckId,
  ReadinessReport,
  ServerSettings,
} from "@brainstorm-agentic/protocol";
import {
  cacheJobs,
  cachedJobs,
  cancelJob,
  diagnoseReadiness,
  blockedReadiness,
  errorMessage,
  getHealth,
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
} from "../api";
import { jobDot, jobStatusLine } from "../format";
import { Dot } from "./common";
import { ResumeIcon, TrashIcon, XIcon } from "./Icons";
import {
  ProviderOnboarding,
  onboardingDismissed,
  onboardingNeeded,
} from "./ProviderOnboarding";
import { SubmissionBox } from "./SubmissionBox";

function JobCard({ job }: { readonly job: JobSummary }) {
  const [confirming, setConfirming] = useState<"cancel" | "trash" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const cancellable =
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "suspended" ||
    job.status === "orphaned";
  // Running/queued/suspended jobs must be stopped before they can be trashed.
  const trashable =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "orphaned";
  // An interrupted job (SLURM timeout, node failure, power cut) resumes from
  // its last checkpoint with one click.
  const resumable = job.status === "orphaned";

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

  const resume = async (): Promise<void> => {
    setResuming(true);
    setActionError(null);
    try {
      await resumeInterruptedJob(job.jobId);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setResuming(false);
    }
  };

  return (
    <li className="job-card">
      <a
        className="job-card-main"
        href={`#/jobs/${encodeURIComponent(job.jobId)}`}
        onMouseEnter={() => prefetchJobDetail(job.jobId)}
        onFocus={() => prefetchJobDetail(job.jobId)}
      >
        <span className="job-topic">{job.topic}</span>
        <span className="job-status-line">
          <Dot state={jobDot(job.status)} />
          <span>{jobStatusLine(job)}</span>
        </span>
      </a>
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
                aria-label={`resume interrupted job from its last checkpoint: ${job.topic}`}
                data-tooltip="resume from checkpoint"
                disabled={resuming}
                onClick={() => void resume()}
              >
                <ResumeIcon size={16} />
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
                aria-label={`cancel job: ${job.topic}`}
                onClick={() => {
                  setActionError(null);
                  setConfirming("cancel");
                }}
              >
                <XIcon />
              </button>
            )}
          </div>
        )
      )}
    </li>
  );
}

/** Last bundle version this browser has acknowledged as "seen". */
const BUNDLE_ACK_KEY = "brain-acked-bundle-version";

function ackedBundleVersion(): string | null {
  try {
    return localStorage.getItem(BUNDLE_ACK_KEY);
  } catch {
    return null;
  }
}

function ackBundleVersion(version: string): void {
  try {
    localStorage.setItem(BUNDLE_ACK_KEY, version);
  } catch {
    // Storage unavailable; the notice simply reappears next visit.
  }
}

/**
 * Pull-based update notices: a newly published skills bundle (new runs pick
 * it up automatically — the notice only informs), a newer bundle while a
 * deployment pin holds runs behind it, and a newer app release tag. Nothing
 * here changes behavior; skill updates need no user action at all.
 */
function UpdateNotices() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ackedVersion, setAckedVersion] = useState<string | null>(ackedBundleVersion);

  useEffect(() => {
    let live = true;
    const poll = () => {
      getHealth()
        .then((response) => {
          if (live) setHealth(response);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 5 * 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  // First visit establishes the baseline silently: "updated" only means
  // "newer than what this browser saw before", never "newer than nothing".
  useEffect(() => {
    const latest = health?.contentRegistry.latest;
    if (latest && ackedVersion === null) {
      ackBundleVersion(latest);
      setAckedVersion(latest);
    }
  }, [health, ackedVersion]);

  if (!health) return null;
  const registry = health.contentRegistry;
  const bundleBehind =
    registry.latest !== undefined &&
    registry.pinnedVersion !== undefined &&
    registry.latest !== registry.pinnedVersion;
  const skillsUpdated =
    registry.latest !== undefined &&
    registry.pinnedVersion === undefined &&
    ackedVersion !== null &&
    registry.latest !== ackedVersion;
  if (!bundleBehind && !skillsUpdated && !health.appUpdate) return null;
  return (
    <div className="update-notices">
      {skillsUpdated && (
        <div className="banner banner-actionable">
          <span>
            Brain skills updated: <strong>{registry.bundle ?? "brainstorm"} v{registry.latest}</strong>
            {registry.latestNotes ? <> — {registry.latestNotes}</> : null}. New
            pipelines use it automatically; nothing to do.
          </span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              ackBundleVersion(registry.latest!);
              setAckedVersion(registry.latest!);
            }}
          >
            Got it
          </button>
        </div>
      )}
      {bundleBehind && (
        <div className="banner">
          Bundle <strong>{registry.latest}</strong> is published — runs are
          pinned to {registry.pinnedVersion} by the deployment.
          {registry.latestNotes ? <> {registry.latestNotes}</> : null}
        </div>
      )}
      {health.appUpdate && (
        <div className="banner">
          App <strong>{health.appUpdate.version}</strong> is available
          (running {health.version}).
          {health.appUpdate.notes ? <> {health.appUpdate.notes}</> : null}{" "}
          Update with <code>git pull</code>, rebuild, and restart — active
          runs resume from their checkpoints.
        </div>
      )}
    </div>
  );
}

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

  const submit = async (
    topic: string,
    attachmentPaths: readonly string[],
  ): Promise<void> => {
    setSubmitError(null);
    try {
      await submitJob(topic, attachmentPaths);
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
        <UpdateNotices />
        <SubmissionBox
          onSubmit={submit}
          onOpenSettings={onOpenSettings}
          readiness={readiness}
          onRecheckReadiness={recheck}
          onDiagnoseReadiness={diagnose}
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
              <JobCard key={job.jobId} job={job} />
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
