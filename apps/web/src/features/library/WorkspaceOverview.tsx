import { useEffect, useSyncExternalStore } from "react";
import type { JobSummary, ReadinessCheckId, ReadinessReport } from "@brainstorm-agentic/protocol";
import { cacheJobs, cachedJobs, diagnoseReadiness, errorMessage, getJobs, getReadiness, jobsStreamUrl, recheckReadiness, useServerEvents } from "../../api";
import { createOverviewState } from "./overview-state";

const overview = createOverviewState(cachedJobs());
const dormantSubscription = () => () => undefined;
let jobsRequest: Promise<void> | undefined;
let readinessRequest: Promise<void> | undefined;
let jobsRevision = 0;
let readinessRevision = 0;

export function publishOverviewJobs(jobs: readonly JobSummary[]): void {
  jobsRevision += 1;
  cacheJobs(jobs);
  overview.jobs.publish({ data: jobs, loading: false, error: null });
}

export function publishOverviewReadiness(report: ReadinessReport): void {
  readinessRevision += 1;
  const previous = overview.readiness.getSnapshot();
  if (!previous.loading && !previous.error && JSON.stringify(previous.data) === JSON.stringify(report)) return;
  overview.readiness.publish({ data: report, loading: false, error: null });
}

export function refreshOverviewJobs(): Promise<void> {
  if (jobsRequest) return jobsRequest;
  const revision = jobsRevision;
  overview.jobs.publish({ ...overview.jobs.getSnapshot(), loading: true, error: null });
  jobsRequest = getJobs().then((jobs) => {
    if (revision === jobsRevision) publishOverviewJobs(jobs);
    else {
      const current = overview.jobs.getSnapshot();
      if (current.data) cacheJobs(current.data);
      if (current.loading || current.error) overview.jobs.publish({ ...current, loading: false, error: null });
    }
  }).catch((error: unknown) => {
    if (revision === jobsRevision) overview.jobs.publish({ ...overview.jobs.getSnapshot(), loading: false, error: errorMessage(error) });
  }).finally(() => { jobsRequest = undefined; });
  return jobsRequest;
}

export function refreshOverviewReadiness(): Promise<void> {
  if (readinessRequest) return readinessRequest;
  const revision = readinessRevision;
  overview.readiness.publish({ ...overview.readiness.getSnapshot(), loading: true, error: null });
  readinessRequest = getReadiness().then((report) => {
    if (revision === readinessRevision) publishOverviewReadiness(report);
  }).catch((error: unknown) => {
    if (revision === readinessRevision) overview.readiness.publish({ ...overview.readiness.getSnapshot(), loading: false, error: errorMessage(error) });
  }).finally(() => { readinessRequest = undefined; });
  return readinessRequest;
}

export function recheckOverviewReadiness(checks?: readonly ReadinessCheckId[]): void {
  void recheckReadiness(checks).then(publishOverviewReadiness).catch((error: unknown) => {
    overview.readiness.publish({ ...overview.readiness.getSnapshot(), error: errorMessage(error), loading: false });
  });
}

export function diagnoseOverviewReadiness(check: ReadinessCheckId): void {
  void diagnoseReadiness(check).then(publishOverviewReadiness).catch((error: unknown) => {
    overview.readiness.publish({ ...overview.readiness.getSnapshot(), error: errorMessage(error), loading: false });
  });
}

export function useOverviewJobs(active = true) {
  return useSyncExternalStore(active ? overview.jobs.subscribe : dormantSubscription, overview.jobs.getSnapshot);
}

export function useOverviewReadiness(active = true) {
  return useSyncExternalStore(active ? overview.readiness.subscribe : dormantSubscription, overview.readiness.getSnapshot);
}

export function useOverviewConnection(active = true) {
  return useSyncExternalStore(active ? overview.connected.subscribe : dormantSubscription, overview.connected.getSnapshot);
}

/** Mount once in the shell. Both the sidebar and composer consume this feed. */
export function WorkspaceOverview({ active, readinessActive = false }: { readonly active: boolean; readonly readinessActive?: boolean }) {
  const subscribed = active || readinessActive;
  const connected = useServerEvents(jobsStreamUrl, (event) => {
    if (event.type === "jobs") publishOverviewJobs(event.jobs);
    if (event.type === "readiness") publishOverviewReadiness(event.readiness);
  }, subscribed);
  useEffect(() => { overview.connected.publish(subscribed && connected); }, [subscribed, connected]);
  useEffect(() => {
    if (!active) return;
    void refreshOverviewJobs();
  }, [active]);
  useEffect(() => {
    if (subscribed) void refreshOverviewReadiness();
  }, [subscribed]);
  return null;
}
