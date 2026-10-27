import { backgroundOptions, type BackgroundId } from "./catalog";
import type { BackgroundFactory } from "./types";
import { loadOptionalModule } from "../optional-module";

type Loader = (() => Promise<BackgroundFactory>) | null;

/** Reviewed, bundled modules only. No remote script URLs or uploaded JavaScript. */
const loaders = {
  aurora: () => loadOptionalModule(() => import("./aurora")).then((module) => module.mountAurora),
  orbit: () => loadOptionalModule(() => import("./orbit")).then((module) => module.mountOrbit),
  none: null,
} satisfies Record<BackgroundId, Loader>;

export const backgroundRegistry = backgroundOptions.map((option) => ({
  ...option,
  load: loaders[option.id],
}));
