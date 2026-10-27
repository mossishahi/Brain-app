import { useEffect, useRef } from 'react';
import { parseRoute, resolveRoute } from './routes';
import { dismissTransientOnNavigation } from './transient-navigation';

/** Close old workspace controls when navigating, without swallowing click-through actions. */
export function useNavigationDismiss(dismiss: () => void) {
  const current = useRef(dismiss);
  current.current = dismiss;
  useEffect(() => {
    const close = (event: HashChangeEvent) => {
      // Use this event's snapshots: another navigation may already have changed
      // window.location by the time a queued hashchange is delivered.
      const previous = parseRoute(new URL(event.oldURL).hash);
      const next = resolveRoute(new URL(event.newURL).hash, previous);
      if (dismissTransientOnNavigation(previous, next)) current.current();
    };
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);
}
