import type { JobSummary, ReadinessReport } from "@brainstorm-agentic/protocol";

export interface LoadState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Independent subscriptions keep list updates out of the active composer. */
function channel<T>(initial: T) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish: (next: T) => {
      if (Object.is(snapshot, next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

export function createOverviewState(initialJobs: readonly JobSummary[] | null = null) {
  return {
    jobs: channel<LoadState<readonly JobSummary[]>>({ data: initialJobs, loading: false, error: null }),
    readiness: channel<LoadState<ReadinessReport>>({ data: null, loading: false, error: null }),
    connected: channel(false),
  };
}
