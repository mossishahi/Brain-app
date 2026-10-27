import { useSyncExternalStore } from 'react';
import type { GpuSetupReport } from '@brainstorm-agentic/protocol';
import { errorMessage, getGpuSetup } from '../../api';

type Snapshot = { report: GpuSetupReport | null; loading: boolean; pending: boolean; error: string | null };
let snapshot: Snapshot = { report: null, loading: false, pending: false, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let read: Promise<void> | undefined;
let revision = 0;
function publish(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener());
}
function schedule() {
  if (timer) clearTimeout(timer);
  if (!listeners.size) return;
  const busy = snapshot.report?.phase === 'discovering' || snapshot.report?.phase === 'probing';
  timer = setTimeout(() => { void refreshGpuSetup(); }, busy ? 1500 : 15_000);
}
export function refreshGpuSetup(): Promise<void> {
  if (read) return read;
  const mine = revision;
  publish({ loading: !snapshot.report });
  read = getGpuSetup().then(report => {
    if (mine === revision) publish({ report, loading: false, error: null });
  }, error => {
    if (mine === revision) publish({ loading: false, error: errorMessage(error) });
  }).finally(() => { read = undefined; schedule(); });
  return read;
}
const settingsChanged = () => { void refreshGpuSetup(); };
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('brain-settings-updated', settingsChanged);
    void refreshGpuSetup();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer) clearTimeout(timer);
      window.removeEventListener('brain-settings-updated', settingsChanged);
    }
  };
}
export function useGpuSetup() { return useSyncExternalStore(subscribe, () => snapshot); }

/** One mutation at a time; a read started before it cannot undo its result. */
export async function mutateGpuSetup(action: () => Promise<GpuSetupReport>): Promise<GpuSetupReport | undefined> {
  if (snapshot.pending) return;
  revision += 1;
  publish({ pending: true, error: null });
  try {
    const report = await action();
    revision += 1;
    publish({ report, pending: false, loading: false, error: null });
    schedule();
    return report;
  } catch (error) {
    revision += 1;
    publish({ pending: false, error: errorMessage(error) });
    schedule();
    return undefined;
  }
}
