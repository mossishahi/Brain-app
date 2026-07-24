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

/**
 * Decorative Vanta layers rendered only in the left/right side margins. Two
 * narrow canvases avoid spending GPU work behind the opaque application column
 * and ensure center-focused effects such as HALO remain visible on both sides.
 */
export function AmbientBackdrop({ theme }: { theme: Theme }) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hosts = [leftRef.current, rightRef.current].filter(
      (host): host is HTMLDivElement => host !== null,
    );
    if (
      hosts.length === 0 ||
      window.matchMedia("(max-width: 1180px)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let cancelled = false;
    const effects: VantaInstance[] = [];

    const initialize = async () => {
      try {
        if (theme === "dark") {
          const [module, THREE] = await Promise.all([
            import("vanta/dist/vanta.halo.min"),
            import("three"),
          ]);
          if (cancelled) return;
          const factory = effectFactory(module);
          for (const [index, host] of hosts.entries()) {
            effects.push(
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
        } else {
          const [module, THREE] = await Promise.all([
            import("vanta/dist/vanta.clouds.min"),
            import("three"),
          ]);
          if (cancelled) return;
          const factory = effectFactory(module);
          for (const host of hosts) {
            effects.push(
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
        }
      } catch (error) {
        // Keep the normal theme background when WebGL/effect setup is unavailable.
        console.warn("Vanta background could not initialize", error);
      }
    };

    void initialize();
    return () => {
      cancelled = true;
      effects.forEach((effect) => effect.destroy());
    };
  }, [theme]);

  return (
    <>
      <div
        ref={leftRef}
        className={`ambient-vanta ambient-vanta-left ambient-vanta-${theme}`}
        aria-hidden
      />
      <div
        ref={rightRef}
        className={`ambient-vanta ambient-vanta-right ambient-vanta-${theme}`}
        aria-hidden
      />
    </>
  );
}
