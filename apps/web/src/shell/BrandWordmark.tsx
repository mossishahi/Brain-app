import { memo, useEffect, useState } from 'react';
import './brand-wordmark.css';

const NAME = 'co-inference';
const CYCLE_MS = 60_000;
const INTRO_DELAY_MS = 5_000;
type Frame = { at: number; text: string; typing: boolean };

// Whole characters retain the existing proportional font without clipped glyphs.
function makeFrames(): Frame[] {
  const frames: Frame[] = [{ at: 0, text: '', typing: true }];
  let at = 0;
  const append = (delay: number, text: string, typing = true) => {
    at += delay;
    frames.push({ at, text, typing });
  };
  for (let length = 1; length <= 9; length++) append(length === 1 ? 200 : 105, 'inference'.slice(0, length));
  for (let length = 8; length >= 0; length--) append(length === 8 ? 850 : 65, 'inference'.slice(0, length));
  for (let length = 1; length <= 3; length++) append(length === 1 ? 250 : 110, 'co-'.slice(0, length));
  for (let length = 1; length <= 9; length++) append(length === 1 ? 1_000 : 105, `co-${'inference'.slice(0, length)}`, length !== 9);
  return frames;
}
const FRAMES = makeFrames();
const REST = FRAMES[FRAMES.length - 1]!;

/** An isolated, minute-long cycle; only the wordmark renders on a keystroke. */
export const BrandWordmark = memo(function BrandWordmark({ introReady }: { introReady: boolean }) {
  const [frame, setFrame] = useState(REST);

  useEffect(() => {
    if (!introReady) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Keep the complete identity visible while the headline types, then wait
    // five full seconds before starting the first minute-long logo cycle.
    let epoch = performance.now() + INTRO_DELAY_MS;
    let timer: number | undefined;
    const clear = () => { window.clearTimeout(timer); timer = undefined; };
    const tick = () => {
      clear();
      if (reducedMotion.matches || document.hidden) { setFrame(REST); return; }
      const sinceStart = performance.now() - epoch;
      if (sinceStart < 0) {
        setFrame(REST);
        timer = window.setTimeout(tick, -sinceStart);
        return;
      }
      // Sample the current phase instead of replaying missed letters after sleep.
      const elapsed = sinceStart % CYCLE_MS;
      let index = 0;
      while (index + 1 < FRAMES.length && FRAMES[index + 1]!.at <= elapsed) index++;
      setFrame(FRAMES[index]!);
      const next = FRAMES[index + 1]?.at ?? CYCLE_MS;
      timer = window.setTimeout(tick, Math.max(1, next - elapsed));
    };
    const changeMotion = () => { epoch = performance.now() + INTRO_DELAY_MS; tick(); };
    reducedMotion.addEventListener('change', changeMotion);
    document.addEventListener('visibilitychange', tick);
    tick();
    return () => {
      clear();
      reducedMotion.removeEventListener('change', changeMotion);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [introReady]);

  return <span className="brand-wordmark" aria-hidden="true">
    <span className="brand-wordmark-size">{NAME}</span>
    <span className="brand-wordmark-text" data-typing={frame.typing || undefined}>{frame.text}</span>
  </span>;
});
