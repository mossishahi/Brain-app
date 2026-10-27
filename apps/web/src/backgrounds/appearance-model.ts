import { backgroundOptions, type BackgroundId } from "./catalog.js";

export type AppearanceTheme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type BackgroundQuality = "low" | "balanced";

export interface AppearancePreferences {
  readonly theme: AppearanceTheme;
  readonly background: BackgroundId;
  readonly motion: boolean;
  readonly quality: BackgroundQuality;
}

export const APPEARANCE_STORAGE_KEY = "brain.appearance.v1";
export const DEFAULT_APPEARANCE: AppearancePreferences = Object.freeze({
  theme: "system",
  background: "aurora",
  motion: true,
  quality: "balanced",
});

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Only the four public appearance fields cross the persistence boundary. */
export function normalizeAppearance(
  value: unknown,
  fallback: AppearancePreferences = DEFAULT_APPEARANCE,
): AppearancePreferences {
  const input = record(value);
  return {
    theme: input.theme === "system" || input.theme === "light" || input.theme === "dark"
      ? input.theme : fallback.theme,
    background: backgroundOptions.some(({ id }) => id === input.background)
      ? input.background as BackgroundId : fallback.background,
    motion: typeof input.motion === "boolean" ? input.motion : fallback.motion,
    quality: input.quality === "low" || input.quality === "balanced"
      ? input.quality : fallback.quality,
  };
}

export function readAppearance(
  serialized: string | null,
  legacyTheme: string | null = null,
): AppearancePreferences {
  const fallback = normalizeAppearance({ theme: legacyTheme });
  if (serialized === null) return fallback;
  try {
    const stored = record(JSON.parse(serialized));
    return stored.version === 1
      ? normalizeAppearance(stored.preferences, fallback)
      : fallback;
  } catch {
    return fallback;
  }
}

export function serializeAppearance(preferences: AppearancePreferences): string {
  return JSON.stringify({ version: 1, preferences: normalizeAppearance(preferences) });
}

export function sameAppearance(a: AppearancePreferences, b: AppearancePreferences): boolean {
  return a.theme === b.theme && a.background === b.background &&
    a.motion === b.motion && a.quality === b.quality;
}
