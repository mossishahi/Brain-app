import { useEffect, useRef } from "react";

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

async function createEffects(
  theme: Theme,
  hosts: readonly HTMLDivElement[],
): Promise<VantaInstance[]> {
  if (theme === "dark") {
    const [module, THREE] = await Promise.all([
      import("vanta/dist/vanta.halo.min"),
      import("three"),
    ]);
    const factory = effectFactory(module);
    return hosts.map((host, index) =>
      factory({
        el: host,
        THREE,
        mouseControls: false,
        touchControls: false,
        gyroControls: false,
        minWidth: 1,
        backgroundColor: 0x121212,
        baseColor: 0x17346d,
        color2: 0x6ea0ff,
        amplitudeFactor: 0.35,
        ringFactor: 0.8,
        rotationFactor: 0.12,
        // Place each halo's dark core beneath the opaque dashboard;
        // only the outer waves remain visible in the side canvas.
        xOffset: index === 0 ? 0.65 : -0.65,
        size: 2.1,
        speed: 0.002,
        mouseEase: false,
        scale: 1.25,
        scaleMobile: 1,
      }),
    );
  }
  const [module, THREE] = await Promise.all([
    import("vanta/dist/vanta.clouds.min"),
    import("three"),
  ]);
  const factory = effectFactory(module);
  return hosts.map((host) =>
    factory({
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
      speed: 0.25,
      mouseEase: false,
      scale: 4,
      scaleMobile: 8,
    }),
  );
}

/**
 * Decorative Vanta layers rendered only in the left/right side margins. Theme
 * switches crossfade between per-theme host elements via CSS opacity, then
 * destroy the hidden theme's effects: at rest exactly one theme's WebGL loops
 * run, so the switch is smooth without a lasting rendering cost.
 */
export function AmbientBackdrop({ theme }: { theme: Theme }) {
  const darkLeftRef = useRef<HTMLDivElement>(null);
  const darkRightRef = useRef<HTMLDivElement>(null);
  const lightLeftRef = useRef<HTMLDivElement>(null);
  const lightRightRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<Record<Theme, VantaInstance[]>>({
    light: [],
    dark: [],
  });
  const disposeTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (
      window.matchMedia("(max-width: 1180px)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let cancelled = false;
    window.clearTimeout(disposeTimerRef.current);

    const hosts = (
      theme === "dark"
        ? [darkLeftRef.current, darkRightRef.current]
        : [lightLeftRef.current, lightRightRef.current]
    ).filter((host): host is HTMLDivElement => host !== null);

    const ensure = async () => {
      if (hosts.length === 0 || instancesRef.current[theme].length > 0) return;
      try {
        const created = await createEffects(theme, hosts);
        if (cancelled) {
          created.forEach((effect) => effect.destroy());
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
      instancesRef.current[other].forEach((effect) => effect.destroy());
      instancesRef.current[other] = [];
    }, DISPOSE_AFTER_MS);

    return () => {
      cancelled = true;
    };
  }, [theme]);

  useEffect(
    () => () => {
      window.clearTimeout(disposeTimerRef.current);
      for (const key of ["light", "dark"] as const) {
        instancesRef.current[key].forEach((effect) => effect.destroy());
        instancesRef.current[key] = [];
      }
    },
    [],
  );

  const hiddenUnless = (target: Theme): string =>
    theme === target ? "" : " ambient-vanta-hidden";

  return (
    <>
      <div
        ref={darkLeftRef}
        className={`ambient-vanta ambient-vanta-left ambient-vanta-dark${hiddenUnless("dark")}`}
        aria-hidden
      />
      <div
        ref={darkRightRef}
        className={`ambient-vanta ambient-vanta-right ambient-vanta-dark${hiddenUnless("dark")}`}
        aria-hidden
      />
      <div
        ref={lightLeftRef}
        className={`ambient-vanta ambient-vanta-left ambient-vanta-light${hiddenUnless("light")}`}
        aria-hidden
      />
      <div
        ref={lightRightRef}
        className={`ambient-vanta ambient-vanta-right ambient-vanta-light${hiddenUnless("light")}`}
        aria-hidden
      />
    </>
  );
}
