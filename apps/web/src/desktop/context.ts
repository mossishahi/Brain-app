import { connectionIdFromPath, researchApiBase, scopedStorageKey } from './paths';

declare global {
  interface Window {
    __CO_INFERENCE_LAUNCHER__?: { version: number };
  }
}

export const isLauncher = typeof window !== 'undefined' && window.__CO_INFERENCE_LAUNCHER__?.version === 1;
const pathname = typeof window === 'undefined' ? '/' : window.location.pathname;
export const activeConnectionId = connectionIdFromPath(pathname, isLauncher);
export const API_BASE = researchApiBase(pathname, isLauncher);
export const hostStorageKey = (key: string): string => scopedStorageKey(key, pathname, isLauncher);
