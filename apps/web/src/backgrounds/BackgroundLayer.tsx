import { useEffect, useRef, useState } from "react";
import { useAppearance } from "./appearance-store";
import { backgroundRegistry } from "./registry";
import type { BackgroundInstance, BackgroundRenderState } from "./types";
import "./backgrounds.css";

export interface BackgroundLayerProps {
  readonly subdued?: boolean;
  /** Pauses decoration only; never connects to run/event-stream lifecycle. */
  readonly paused?: boolean;
}

export function BackgroundLayer({ subdued = false, paused = false }: BackgroundLayerProps) {
  const appearance = useAppearance();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<BackgroundInstance | null>(null);
  const current = useRef<BackgroundRenderState>({
    theme: appearance.resolvedTheme, motion: appearance.effectiveMotion,
    quality: appearance.quality, paused,
  });
  current.current = {
    theme: appearance.resolvedTheme, motion: appearance.effectiveMotion,
    quality: appearance.quality, paused,
  };
  const [failed, setFailed] = useState<string | null>(null);
  const reportError = useRef<(error: unknown) => void>(() => {});

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const controller = new AbortController();
    let mounted: BackgroundInstance | null = null;
    setFailed(null);

    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      controller.abort();
      try { mounted?.dispose(); } catch { /* Keep decoration isolated from app errors. */ }
      instance.current = null;
      host.replaceChildren();
      setFailed(appearance.background);
      const environment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
      if (environment?.DEV) console.warn("Background unavailable; using a plain surface.", error);
    };
    reportError.current = fail;
    const definition = backgroundRegistry.find(({ id }) => id === appearance.background);
    if (definition?.load) {
      void definition.load().then((mount) => {
        if (controller.signal.aborted) return;
        mounted = mount({ ...current.current, container: host, signal: controller.signal, onError: fail });
        if (controller.signal.aborted) {
          mounted.dispose();
          host.replaceChildren();
        } else {
          instance.current = mounted;
        }
      }).catch(fail);
    }

    return () => {
      controller.abort();
      try { mounted?.dispose(); } catch { /* Unmount must not disrupt the application. */ }
      if (instance.current === mounted) instance.current = null;
      host.replaceChildren();
    };
  }, [appearance.background]);

  useEffect(() => {
    try { instance.current?.update(current.current); }
    catch (error) { reportError.current(error); }
  }, [appearance.resolvedTheme, appearance.effectiveMotion, appearance.quality, paused]);

  return (
    <div
      className={`brain-background${subdued ? " brain-background--subdued" : ""}`}
      data-background={failed === appearance.background ? "none" : appearance.background}
      data-background-theme={appearance.resolvedTheme}
      aria-hidden="true"
      inert
    >
      <div ref={container} className="brain-background-renderer" />
    </div>
  );
}
