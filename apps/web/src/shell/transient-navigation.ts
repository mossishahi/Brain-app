import type { Route } from './routes';

/** Keep a workspace control opened by the same click that dismisses the library. */
export function dismissTransientOnNavigation(previous: Route, next: Route): boolean {
  if (previous.view !== next.view) return true;
  if (previous.view === 'job' && next.view === 'job'
    && (previous.jobId !== next.jobId || previous.stage !== next.stage)) return true;
  return next.panel !== undefined && next.panel !== previous.panel;
}
