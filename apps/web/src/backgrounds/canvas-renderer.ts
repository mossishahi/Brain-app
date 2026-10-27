import { renderBudget } from "./render-budget";
import type { BackgroundFactory, BackgroundRenderState } from "./types";

export interface BackgroundFrame {
  readonly context: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly time: number;
  readonly dark: boolean;
}

export type BackgroundPainter = (frame: BackgroundFrame) => void;

/** Reuse this lifecycle for custom Canvas2D designs; painters only draw a frame. */
export function canvasRenderer(paint: BackgroundPainter): BackgroundFactory {
  return (options) => {
    if (options.signal.aborted) return { update() {}, dispose() {} };
    const canvas = document.createElement("canvas");
    canvas.className = "brain-background-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas2D is unavailable for decorative rendering.");
    options.container.append(canvas);

    let state: BackgroundRenderState = { ...options };
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame: number | null = null;
    let lastTime: number | null = null;
    let elapsed = 4;
    let width = 1;
    let height = 1;
    let budget = renderBudget(width, height, 1, state.quality);
    let disposed = false;
    let needsResize = true;
    let observer: ResizeObserver | undefined;

    const animated = () => state.motion && !state.paused && !preference.matches;
    const resize = () => {
      const bounds = options.container.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      budget = renderBudget(width, height, window.devicePixelRatio, state.quality);
      canvas.width = budget.width;
      canvas.height = budget.height;
      needsResize = false;
    };

    const draw = () => {
      if (needsResize) resize();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(budget.scale, 0, 0, budget.scale, 0, 0);
      // A custom painter cannot leak transforms or clipping into the next frame.
      context.save();
      try {
        paint({ context, width, height, time: elapsed, dark: state.theme === "dark" });
      } finally {
        context.restore();
      }
    };

    const stop = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      lastTime = null;
    };

    const tick = (now: number) => {
      frame = null;
      if (disposed || document.hidden) return;
      try {
        if (lastTime === null || now - lastTime >= budget.frameInterval || needsResize) {
          if (lastTime !== null && animated()) elapsed += Math.min((now - lastTime) / 1000, 0.15);
          draw();
          lastTime = now;
        }
        if (animated()) frame = window.requestAnimationFrame(tick);
      } catch (error) {
        dispose();
        options.onError(error);
      }
    };

    const schedule = () => {
      if (!disposed && !document.hidden && frame === null) {
        frame = window.requestAnimationFrame(tick);
      }
    };
    const onResize = () => { needsResize = true; schedule(); };
    const onVisibility = () => { stop(); schedule(); };
    const onPreference = () => { stop(); schedule(); };

    function dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      preference.removeEventListener("change", onPreference);
      options.signal.removeEventListener("abort", dispose);
      canvas.remove();
      // Release the backing bitmap promptly when changing designs.
      canvas.width = 1;
      canvas.height = 1;
    }

    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onResize);
      observer.observe(options.container);
    }
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    preference.addEventListener("change", onPreference);
    options.signal.addEventListener("abort", dispose, { once: true });
    schedule();

    return {
      update(next) {
        if (disposed) return;
        if (state.quality !== next.quality) needsResize = true;
        state = { ...next };
        stop();
        schedule();
      },
      dispose,
    };
  };
}
