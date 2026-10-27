import { useSyncExternalStore } from 'react';
import type { ServerSettings } from '@brainstorm-agentic/protocol';
import { errorMessage, getSettings, updateSettings } from '../../api';
import { projectQuickSetting, quickSettingsPatch, type QuickCommand, type QuickSetting, type QuickValue } from './settings-commands';

type Status = { pending?: boolean; error?: string };
type Snapshot = { data: ServerSettings | null; loading: boolean; error?: string; status: Partial<Record<QuickSetting, Status>> };
let confirmed: ServerSettings | null = null;
let snapshot: Snapshot = { data: null, loading: false, status: {} };
const pending = new Map<QuickSetting, QuickCommand>();
const listeners = new Set<() => void>();
let read: Promise<void> | undefined;
function publish(patch: Partial<Snapshot> = {}) {
  let data = confirmed;
  for (const command of pending.values()) {
    if (data) { try { data = projectQuickSetting(data, command); } catch { /* A dependency changed; retain server state. */ } }
  }
  snapshot = { ...snapshot, ...patch, data };
  listeners.forEach(listener => listener());
}
function receive(event: Event) {
  confirmed = (event as CustomEvent<ServerSettings>).detail;
  publish();
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('brain-settings-updated', receive);
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('brain-settings-updated', receive); };
}
export function useQuickSettings() { return useSyncExternalStore(subscribe, () => snapshot); }
export function loadQuickSettings(): Promise<void> {
  if (read) return read;
  publish({ loading: true, error: undefined });
  read = getSettings().then(data => { confirmed = data; publish({ loading: false, error: undefined }); }, error => publish({ loading: false, error: errorMessage(error) })).finally(() => { read = undefined; });
  return read;
}
export async function changeQuickSetting(id: QuickSetting, value: QuickValue): Promise<boolean> {
  if (!confirmed || pending.has(id)) return false;
  const command = { id, value };
  try { quickSettingsPatch(snapshot.data ?? confirmed, command); }
  catch (error) { publish({ status: { ...snapshot.status, [id]: { error: errorMessage(error) } } }); return false; }
  pending.set(id, command);
  publish({ status: { ...snapshot.status, [id]: { pending: true } } });
  try {
    confirmed = await updateSettings(current => quickSettingsPatch(current, command));
    pending.delete(id);
    publish({ status: { ...snapshot.status, [id]: {} } });
    return true;
  } catch (error) {
    pending.delete(id);
    publish({ status: { ...snapshot.status, [id]: { error: errorMessage(error) } } });
    return false;
  }
}
