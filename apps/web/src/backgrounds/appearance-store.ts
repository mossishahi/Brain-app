import { useSyncExternalStore } from "react";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  readAppearance,
  sameAppearance,
  serializeAppearance,
  type AppearancePreferences,
  type ResolvedTheme,
} from "./appearance-model";

export interface AppearanceSnapshot extends AppearancePreferences {
  readonly resolvedTheme: ResolvedTheme;
  readonly reducedMotion: boolean;
  readonly effectiveMotion: boolean;
  /** False means preferences work for this tab but could not be saved locally. */
  readonly persisted: boolean;
}

const serverSnapshot: AppearanceSnapshot = Object.freeze({
  ...DEFAULT_APPEARANCE,
  resolvedTheme: "light",
  reducedMotion: false,
  effectiveMotion: true,
  persisted: true,
});

let snapshot = serverSnapshot;
let initialized = false;
let disposeListeners: (() => void) | undefined;
const subscribers = new Set<() => void>();

function systemPreferences(): { dark: boolean; reduced: boolean } {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { dark: false, reduced: false };
  }
  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

function publish(preferences: AppearancePreferences, persisted = snapshot.persisted): void {
  const system = systemPreferences();
  const resolvedTheme = preferences.theme === "system"
    ? (system.dark ? "dark" : "light") : preferences.theme;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }
  if (sameAppearance(snapshot, preferences) && snapshot.resolvedTheme === resolvedTheme &&
    snapshot.reducedMotion === system.reduced && snapshot.persisted === persisted) return;
  snapshot = Object.freeze({
    ...preferences,
    resolvedTheme,
    reducedMotion: system.reduced,
    effectiveMotion: preferences.motion && !system.reduced,
    persisted,
  });
  for (const subscriber of subscribers) subscriber();
}

function readStorage(): void {
  if (typeof window === "undefined") return;
  try {
    publish(readAppearance(
      window.localStorage.getItem(APPEARANCE_STORAGE_KEY),
      window.localStorage.getItem("brain-theme"),
    ), true);
  } catch {
    // Sandboxed browsers and full storage must not prevent the app from opening.
    publish(initialized ? snapshot : DEFAULT_APPEARANCE, false);
  }
}

function initialize(): void {
  if (initialized || typeof window === "undefined") return;
  readStorage();
  initialized = true;
}

function subscribe(subscriber: () => void): () => void {
  initialize();
  subscribers.add(subscriber);
  if (!disposeListeners && typeof window !== "undefined") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onSystem = () => publish(snapshot);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === APPEARANCE_STORAGE_KEY || event.key === "brain-theme") {
        readStorage();
      }
    };
    dark.addEventListener("change", onSystem);
    reduced.addEventListener("change", onSystem);
    window.addEventListener("storage", onStorage);
    disposeListeners = () => {
      dark.removeEventListener("change", onSystem);
      reduced.removeEventListener("change", onSystem);
      window.removeEventListener("storage", onStorage);
      disposeListeners = undefined;
    };
    onSystem();
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) disposeListeners?.();
  };
}

function getSnapshot(): AppearanceSnapshot {
  initialize();
  return snapshot;
}

export function useAppearance(): AppearanceSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}

/** Applies immediately; the return value tells a control whether storage succeeded. */
export function setAppearance(patch: Partial<AppearancePreferences>): boolean {
  initialize();
  const next = normalizeAppearance(patch, snapshot);
  let persisted = false;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearance(next));
      // Existing index.html reads this key before React starts. Keep its first
      // paint in sync without persisting a resolved system theme as an override.
      if (next.theme === "system") window.localStorage.removeItem("brain-theme");
      else window.localStorage.setItem("brain-theme", next.theme);
      persisted = true;
    }
  } catch {
    // Continue with the in-memory choice and expose an honest persistence state.
  }
  publish(next, persisted);
  return persisted;
}
