/** View 1 — prompt entry plus live job cards. */
import { useEffect, useState } from "react";
import type { JobSummary } from "@brainstorm-agentic/protocol";
import {
  cancelJob,
  errorMessage,
  getJobs,
  jobsStreamUrl,
  submitJob,
  useServerEvents,
} from "../api";
import { jobDot, jobStatusLine } from "../format";
import { Dot } from "./common";
import { XIcon } from "./Icons";
import { SubmissionBox } from "./SubmissionBox";

function JobCard({ job }: { readonly job: JobSummary }) {
  const [confirming, setConfirming] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const cancellable =
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "suspended" ||
    job.status === "orphaned";

  const doCancel = async (): Promise<void> => {
    try {
      await cancelJob(job.jobId);
      setCancelFailed(false);
    } catch {
      setCancelFailed(true);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <li className="job-card">
      <a
        className="job-card-main"
        href={`#/jobs/${encodeURIComponent(job.jobId)}`}
      >
        <span className="job-topic">{job.topic}</span>
        <span className="job-status-line">
          <Dot state={jobDot(job.status)} />
          <span>{jobStatusLine(job)}</span>
        </span>
      </a>
      {confirming ? (
        <div className="cancel-zone">
          <span className="cancel-question">
            Are you sure you want to cancel this job?
          </span>
          <button
            type="button"
            className="btn btn-danger btn-small"
            onClick={() => void doCancel()}
          >
            Yes, cancel
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setConfirming(false)}
          >
            No
          </button>
        </div>
      ) : (
        cancellable && (
          <div className="cancel-zone">
            {cancelFailed && (
              <span className="error-text">cancel failed</span>
            )}
            <button
              type="button"
              className="ghost-btn"
              aria-label={`cancel job: ${job.topic}`}
              onClick={() => {
                setCancelFailed(false);
                setConfirming(true);
              }}
            >
              <XIcon />
            </button>
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
  const [jobs, setJobs] = useState<readonly JobSummary[] | null>(
    null,
  );
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
    if (event.type === "jobs") setJobs(event.jobs);
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
