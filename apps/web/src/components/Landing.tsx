/** View 1 — prompt entry plus live job cards. */
import { useEffect, useState } from "react";
import type { JobSummary } from "@brainstorm-agentic/protocol";
import {
  cacheJobs,
  cachedJobs,
  cancelJob,
  errorMessage,
  getJobs,
  jobsStreamUrl,
  prefetchJobDetail,
  submitJob,
  trashJob,
  useServerEvents,
} from "../api";
import { jobDot, jobStatusLine } from "../format";
import { Dot } from "./common";
import { TrashIcon, XIcon } from "./Icons";
import { SubmissionBox } from "./SubmissionBox";

function JobCard({ job }: { readonly job: JobSummary }) {
  const [confirming, setConfirming] = useState<"cancel" | "trash" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
            {confirming === "cancel"
              ? "Are you sure you want to cancel this job?"
              : "Move this job to the view-only trash?"}
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
        (cancellable || trashable) && (
          <div className="cancel-zone">
            {actionError && (
              <span className="error-text">{actionError}</span>
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

  useEffect(() => {
    let live = true;
    getJobs()
      .then((list) => {
        if (live) setJobs((previous) => previous ?? list);
      })
      .catch(() => {
        if (live) setJobs((previous) => previous ?? []);
      });
    return () => {
      live = false;
    };
  }, []);

  const connected = useServerEvents(jobsStreamUrl, (event) => {
    if (event.type === "jobs") {
      setJobs(event.jobs);
      cacheJobs(event.jobs);
    }
  });

  const submit = async (
    topic: string,
    attachmentPaths: readonly string[],
  ): Promise<void> => {
    setSubmitError(null);
    try {
      await submitJob(topic, attachmentPaths);
      setJobs(await getJobs());
    } catch (error) {
      setSubmitError(errorMessage(error));
      throw error;
    }
  };

  const sorted = jobs
    ? [...jobs].sort(
        (left, right) => right.createdAt - left.createdAt,
      )
    : [];

  return (
    <main className="landing">
      <div className="landing-column">
        <SubmissionBox
          onSubmit={submit}
          onOpenSettings={onOpenSettings}
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
    </main>
  );
}
