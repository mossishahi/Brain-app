import { useSyncExternalStore } from 'react';

// Tab-local choices for future submissions, shared by Settings and the composer.
// An accepted or held run keeps the snapshot it was submitted with.
let draft: Readonly<Record<string, boolean>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => draft;
const publish = (next: Readonly<Record<string, boolean>>) => {
  draft = next;
  listeners.forEach(listener => listener());
};

export const useCapabilityDraft = () => useSyncExternalStore(subscribe, snapshot);
export function setCapabilityOverride(id: string, enabled: boolean): void {
  if (draft[id] === enabled) return;
  publish({ ...draft, [id]: enabled });
}
export function resetCapabilityDraft(): void {
  if (Object.keys(draft).length) publish({});
}
