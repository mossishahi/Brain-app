import { connectionIdFromPath, researchApiBase, scopedStorageKey } from './paths';

export interface HostConnectionSnapshot {
  id: string;
  label: string;
  state: 'checking' | 'ready' | 'attention';
  message: string;
  actionLabel: string;
  actionHref: string;
}

declare global {
  interface Window {
    __CO_INFERENCE_LAUNCHER__?: { version: number };
    __CO_INFERENCE_HOST__?: {
      version: 1;
      getSnapshot: () => HostConnectionSnapshot;
      showDetails: () => void;
    };
  }
}

export const isLauncher = typeof window !== 'undefined' && window.__CO_INFERENCE_LAUNCHER__?.version === 1;
const pathname = typeof window === 'undefined' ? '/' : window.location.pathname;
export const activeConnectionId = connectionIdFromPath(pathname, isLauncher);
export const API_BASE = researchApiBase(pathname, isLauncher);
export const hostStorageKey = (key: string): string => scopedStorageKey(key, pathname, isLauncher);
