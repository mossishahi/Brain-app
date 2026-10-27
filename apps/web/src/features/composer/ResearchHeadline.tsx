import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FIRST_PROFESSION, PROFESSIONS } from './profession-sequence';
import { createProfessionWheel } from './profession-wheel';
import './research-headline.css';

const PREFIX = 'Got a hunch? Start brainstorming with a ';
const HEADING = PREFIX + FIRST_PROFESSION;
const TYPE_MS = 32;

/** Intro renders stay local; the ongoing wheel moves on the compositor. */
export const ResearchHeadline = memo(function ResearchHeadline({ active, onIntroComplete }: { active: boolean; onIntroComplete?: () => void }) {
  const [revealed, setRevealed] = useState(0);
  const count = useRef(0);
  const track = useRef<HTMLSpanElement>(null);
  const activeRef = useRef(active);
  const synchronize = useRef<() => void>(() => {});
  const pointerHover = useRef(false);
  const changeHover = useRef<(hovered: boolean) => void>(() => {});
  const notified = useRef(false);
  const onComplete = useRef(onIntroComplete);
  onComplete.current = onIntroComplete;
  activeRef.current = active;
  const complete = revealed === HEADING.length;

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    const clear = () => window.clearTimeout(timer);
    const tick = () => {
      clear();
      if (reducedMotion.matches) {
        count.current = HEADING.length;
        setRevealed(count.current);
      } else if (active && !document.hidden && count.current < HEADING.length) {
        count.current++;
        setRevealed(count.current);
        timer = window.setTimeout(tick, TYPE_MS);
      }
    };
    const sync = () => {
      clear();
      // Effect reattachment and visibility events must not type extra letters.
      // Only the very first character is immediate; all later ones keep pace.
      if (count.current === 0 || reducedMotion.matches) tick();
      else if (active && !document.hidden && count.current < HEADING.length) timer = window.setTimeout(tick, TYPE_MS);
    };
    reducedMotion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      clear();
      reducedMotion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [active]);
  useEffect(() => {
    if (!complete || notified.current) return;
    notified.current = true;
    onComplete.current?.();
  }, [complete]);

  useLayoutEffect(() => {
    const element = track.current;
    if (!complete || !element) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const wheel = createProfessionWheel(element, () => reducedMotion.matches || document.hidden || !activeRef.current);
    synchronize.current = wheel.sync;
    changeHover.current = wheel.hover;
    reducedMotion.addEventListener('change', wheel.sync);
    document.addEventListener('visibilitychange', wheel.sync);
    if (pointerHover.current) wheel.hover(true);
    return () => {
      synchronize.current = () => {};
      changeHover.current = () => {};
      reducedMotion.removeEventListener('change', wheel.sync);
      document.removeEventListener('visibilitychange', wheel.sync);
      wheel.destroy();
    };
  }, [complete]);
  useEffect(() => synchronize.current(), [active]);

  const letters = (text: string, offset = 0) => [...text].map((letter, index) =>
    <span key={index} style={{ visibility: offset + index < revealed ? 'visible' : 'hidden' }}>{letter}</span>);

  return <h1 className="research-headline" aria-label={HEADING} data-phase={complete ? 'rotating' : 'typing'}>
    <span aria-hidden="true">
      <span className="research-headline-prefix">{complete ? PREFIX : letters(PREFIX)}</span>
      <span className="profession-wheel"
        onPointerEnter={event => {
          if (event.pointerType !== 'mouse' || !window.matchMedia('(any-hover: hover)').matches) return;
          pointerHover.current = true;
          changeHover.current(true);
        }}
        onPointerLeave={event => {
          if (event.pointerType !== 'mouse') return;
          pointerHover.current = false;
          changeHover.current(false);
        }}>
        {PROFESSIONS.map(profession => <span className="profession-measure" key={profession}>{profession}</span>)}
        {!complete && <span className="profession-intro">{letters(FIRST_PROFESSION, PREFIX.length)}</span>}
        <span className="profession-track" ref={track} />
      </span>
    </span>
  </h1>;
});
