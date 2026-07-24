/** View 3 — the read-only trash: stopped jobs removed from the landing list. */
import { useEffect, useState } from "react";
import type { JobSummary } from "@brainstorm-agentic/protocol";
import { errorMessage, getTrashedJobs } from "../api";
import { jobDot, jobStatusLine } from "../format";
import { Dot, SkeletonLines } from "./common";
import { BackIcon } from "./Icons";

function trashedWhen(at: number): string {
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TrashView() {
  const [jobs, setJobs] = useState<readonly JobSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getTrashedJobs()
      .then((list) => {
        if (live) setJobs(list);
      })
      .catch((error: unknown) => {
        if (live) {
          setJobs([]);
          setLoadError(errorMessage(error));
        }
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="dash">
      <header className="dash-header">
        <a href="#/" className="ghost-btn" aria-label="back to all jobs">
          <BackIcon />
        </a>
        <h1 className="dash-title">Trash</h1>
        <span className="dash-status">view-only</span>
      </header>
      {loadError && <div className="banner banner-bad">{loadError}</div>}
      {jobs === null ? (
        <SkeletonLines />
      ) : jobs.length === 0 ? (
        !loadError && (
          <div className="banner">
            The trash is empty. Stopped jobs can be moved here from the job
            list; trashed jobs stay readable but cannot be restarted.
          </div>
        )
      ) : (
        <ul className="job-list">
          {jobs.map((job) => (
            <li key={job.jobId} className="job-card">
              <a
                className="job-card-main"
                href={`#/jobs/${encodeURIComponent(job.jobId)}`}
              >
                <span className="job-topic">{job.topic}</span>
                <span className="job-status-line">
                  <Dot state={jobDot(job.status)} />
                  <span>
                    {jobStatusLine(job)}
                    {job.trashedAt !== undefined &&
                      ` · trashed ${trashedWhen(job.trashedAt)}`}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
