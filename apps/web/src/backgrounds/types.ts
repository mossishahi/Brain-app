import type { BackgroundQuality, ResolvedTheme } from "./appearance-model";

export interface BackgroundRenderState {
  readonly theme: ResolvedTheme;
  /** Already includes the user's reduced-motion preference. */
  readonly motion: boolean;
  readonly quality: BackgroundQuality;
  /** Optional application performance policy; affects decoration only. */
  readonly paused: boolean;
}

export interface BackgroundMountOptions extends BackgroundRenderState {
  readonly container: HTMLElement;
  readonly signal: AbortSignal;
  readonly onError: (error: unknown) => void;
}

export interface BackgroundInstance {
  update(state: BackgroundRenderState): void;
  dispose(): void;
}

export type BackgroundFactory = (options: BackgroundMountOptions) => BackgroundInstance;
