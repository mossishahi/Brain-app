import { useEffect, useRef, useState } from "react";

type Theme = "light" | "dark";

interface VantaInstance {
  destroy(): void;
}

type VantaFactory = (
  options: Record<string, unknown>,
) => VantaInstance;

function effectFactory(module: unknown): VantaFactory {
  let candidate = module;
  for (let depth = 0; depth < 3 && typeof candidate !== "function"; depth += 1) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("default" in candidate)
    ) {
      break;
    }
    candidate = candidate.default;
  }
  if (typeof candidate !== "function") {
    throw new TypeError("Vanta effect module did not export a factory");
  }
  return candidate as VantaFactory;
}

/** Matches the .ambient-vanta opacity transition in theme.css, plus margin. */
const DISPOSE_AFTER_MS = 700;

/**
 * Frames per second the halo renders at, versus the display's usual 60.
 *
 * Its visible drift comes from a feedback buffer — each frame resamples the
 * previous one at a slightly rotated and zoomed offset — which advances once per
 * rendered frame no matter what `speed` says (`speed` only scales the shader's
 * iTime). Rendering less often is the only thing that slows that drift, and it
 * cuts the GPU cost of a viewport-sized shader at the same time.
 */
const HALO_FPS = 15;

/** The Vanta internals the throttle needs; both names survive minification. */
interface VantaLoop {
  animationLoop?: () => unknown;
  req?: number;
}

/**
 * Takes over an effect's animation loop and runs it at `fps`. Vanta schedules
 * each frame by passing its bound loop straight to requestAnimationFrame, so
 * replacing the instance property would not intercept anything: the only
 * reliable seam is to cancel the pending frame and call the loop ourselves.
 */
function throttleRenderRate(effect: VantaInstance, fps: number): void {
  const internals = effect as VantaInstance & VantaLoop;
  const loop = internals.animationLoop;
  if (fps <= 0 || typeof loop !== "function" || typeof internals.req !== "number") {
    return; // Unrecognized build: leave Vanta's own 60fps loop alone.
  }
  const interval = Math.round(1000 / fps);
  let timer: number | undefined;
  const step = () => {
    try {
      loop(); // Renders one frame and schedules its own next one, which we drop.
    } catch (error) {
      // Never leave a timer spinning on a broken loop.
      console.warn("Vanta background stopped", error);
      return;
    }
    if (typeof internals.req === "number") window.cancelAnimationFrame(internals.req);
    timer = window.setTimeout(step, interval);
  };
  window.cancelAnimationFrame(internals.req);
  timer = window.setTimeout(step, interval);

  const destroy = effect.destroy.bind(effect);
  (effect as { destroy: () => void }).destroy = () => {
    window.clearTimeout(timer);
    destroy();
  };
}

async function createEffect(
  theme: Theme,
  host: HTMLDivElement,
): Promise<VantaInstance> {
  if (theme === "dark") {
    const [module, THREE] = await Promise.all([
      import("vanta/dist/vanta.halo.min"),
      import("three"),
    ]);
    const factory = effectFactory(module);
    const halo = factory({
      el: host,
      THREE,
      mouseControls: false,
      touchControls: false,
      gyroControls: false,
      minWidth: 1,
      backgroundColor: 0x121212,
      baseColor: 0x17346d,
      color2: 0x6ea0ff,
      amplitudeFactor: 0.4,
      ringFactor: 0.9,
      // Rotation and speed are what make the rings read as concentric motion
      // rather than a still image. Both are time multipliers: slow enough that
      // the drift is only noticeable if you look for it, but not frozen.
      rotationFactor: 0.12,
      speed: 0.11,
      // Centred: the vignette hides the dark core, so the rings radiate out of
      // the page's middle and reach every margin together.
      xOffset: 0,
      yOffset: 0,
      size: 2,
      mouseEase: false,
      // The scene now covers the viewport rather than two narrow strips, so it
      // renders at half device resolution to keep the pixel cost comparable.
      scale: 2,
      scaleMobile: 2,
    });
    throttleRenderRate(halo, HALO_FPS);
    return halo;
  }
  const [module, THREE] = await Promise.all([
    import("vanta/dist/vanta.clouds.min"),
    import("three"),
  ]);
  const factory = effectFactory(module);
  return factory({
    el: host,
    THREE,
    mouseControls: false,
    touchControls: false,
    gyroControls: false,
    minWidth: 1,
    backgroundColor: 0xfafafa,
    skyColor: 0xbdd7ed,
    cloudColor: 0xf8fbff,
    cloudShadowColor: 0x91abc5,
    sunColor: 0xfff2cf,
    sunGlareColor: 0xffead0,
    sunlightColor: 0xffffff,
    speed: 0.14,
    mouseEase: false,
    scale: 4,
    scaleMobile: 4,
  });
}

/**
 * Mirrors the CSS that hides the backdrop; kept in sync with theme.css.
 * Width alone must not classify a portrait desktop monitor as mobile.
 */
const SUPPRESSED_QUERY =
  "(max-width: 720px), (hover: none) and (pointer: coarse), (prefers-reduced-motion: reduce)";

function useMediaFlag(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    // Evaluated live, not just at mount: resizing or moving the window between
    // monitors has to re-evaluate, not leave the layer where it started.
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * One decorative Vanta scene per theme, covering the viewport and centred on it,
 * revealed only in the margin around the reading column (the vignette lives in
 * theme.css). Vanta resizes its own canvas with the window, so the same scene
 * serves any window shape. Theme switches crossfade between the two scenes and
 * then destroy the hidden one, so at rest exactly one WebGL loop runs.
 */
export function AmbientBackdrop({ theme }: { theme: Theme }) {
  const darkRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<Partial<Record<Theme, VantaInstance>>>({});
  const disposeTimerRef = useRef<number | undefined>(undefined);
  const suppressed = useMediaFlag(SUPPRESSED_QUERY);

  useEffect(() => {
    if (suppressed) {
      // The CSS already hides the scenes; also stop the WebGL loops.
      for (const key of ["light", "dark"] as const) {
        instancesRef.current[key]?.destroy();
        delete instancesRef.current[key];
      }
      return;
    }
    let cancelled = false;
    window.clearTimeout(disposeTimerRef.current);

    const host = theme === "dark" ? darkRef.current : lightRef.current;

    const ensure = async () => {
      if (host === null || instancesRef.current[theme] !== undefined) return;
      try {
        const created = await createEffect(theme, host);
        if (cancelled) {
          created.destroy();
          return;
        }
        instancesRef.current[theme] = created;
      } catch (error) {
        // Keep the normal theme background when WebGL/effect setup is unavailable.
        console.warn("Vanta background could not initialize", error);
      }
    };
    void ensure();

    // Once the CSS crossfade finishes, stop the hidden theme's render loop.
    const other: Theme = theme === "dark" ? "light" : "dark";
    disposeTimerRef.current = window.setTimeout(() => {
      instancesRef.current[other]?.destroy();
      delete instancesRef.current[other];
    }, DISPOSE_AFTER_MS);

    return () => {
      cancelled = true;
    };
  }, [theme, suppressed]);

  useEffect(
    () => () => {
      window.clearTimeout(disposeTimerRef.current);
      for (const key of ["light", "dark"] as const) {
        instancesRef.current[key]?.destroy();
        delete instancesRef.current[key];
      }
    },
    [],
  );

  const hiddenUnless = (target: Theme): string =>
    theme === target ? "" : " ambient-vanta-hidden";

  return (
    <>
      <div
        ref={darkRef}
        className={`ambient-vanta ambient-vanta-dark${hiddenUnless("dark")}`}
        aria-hidden
      />
      <div
        ref={lightRef}
        className={`ambient-vanta ambient-vanta-light${hiddenUnless("light")}`}
        aria-hidden
      />
    </>
  );
}
