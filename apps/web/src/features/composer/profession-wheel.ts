import { createProfessionSequence, FIRST_PROFESSION, PROFESSIONS } from './profession-sequence';

const HOLD_MS = 12_000;
const SLIDE_MS = 200;
const SPIN_MS = 90;
type Mode = 'auto' | 'spinning' | 'settling';

/** One compositor animation owns this decorative subtree, independently of React/editor renders. */
export function createProfessionWheel(element: HTMLSpanElement, suspended: () => boolean) {
  const nextTurn = createProfessionSequence();
  let pending: string[] | undefined;
  let rows: readonly string[] = [FIRST_PROFESSION];
  let animation: Animation | undefined;
  let hovered = false;
  let disposed = false;
  let mode: Mode = 'auto';
  let timing = { start: 0, end: 0, hold: 0, duration: 1 };

  const position = (index: number) => `translateY(-${index * 100 / rows.length}%)`;
  const cancel = () => {
    if (animation) { animation.onfinish = null; animation.cancel(); }
  };
  const render = (names: readonly string[]) => {
    rows = names;
    element.replaceChildren(...rows.map(name => {
      const row = document.createElement('span');
      row.className = 'profession-option';
      const label = document.createElement('span');
      label.className = 'profession-name';
      label.textContent = name;
      row.append(label);
      return row;
    }));
  };
  const progress = () => {
    const time = Number(animation?.currentTime ?? 0);
    const fraction = Math.max(0, Math.min(1, (time - timing.hold) / (timing.duration - timing.hold)));
    const fallback = timing.start + (timing.end - timing.start) * fraction;
    // Read the actual eased position once when interrupted, never on each frame.
    // Hidden/reduced-motion CSS can suppress transforms, so use timing then.
    if (suspended()) return fallback;
    const transform = getComputedStyle(element).transform;
    const height = element.firstElementChild?.getBoundingClientRect().height ?? 0;
    if (transform === 'none' || !height) return fallback;
    return Math.max(0, Math.min(rows.length - 1, -new DOMMatrixReadOnly(transform).m42 / height));
  };
  function animate(nextMode: Mode, start: number, end: number, hold: number, duration: number, easing: string, finish: () => void) {
    cancel();
    mode = nextMode;
    timing = { start, end, hold, duration };
    element.parentElement!.dataset.motion = mode;
    const frames: Keyframe[] = [{ transform: position(start), offset: 0 }];
    if (hold) frames.push({ transform: position(start), offset: hold / duration, easing });
    else frames[0]!.easing = easing;
    frames.push({ transform: position(end), offset: 1 });
    const turn = element.animate(frames, { duration, fill: 'forwards' });
    turn.id = 'research-professions';
    animation = turn;
    turn.onfinish = () => { if (!disposed && animation === turn) finish(); };
    if (suspended()) turn.pause();
  }
  function automatic(current: string) {
    // Keep an already drawn automatic stop through hover interruptions. Hover
    // names use a separate reel and never consume the balanced automatic bag.
    if (!pending || pending[pending.length - 1] === current) pending = nextTurn(current);
    const target = pending[pending.length - 1]!;
    const names = [current, ...pending.slice(1, -1).filter(name => name !== current), target];
    render(names);
    const steps = names.length - 1;
    animate('auto', 0, steps, HOLD_MS, HOLD_MS + steps * SLIDE_MS,
      steps === 1 ? 'cubic-bezier(.22, 1, .36, 1)' : 'linear', () => {
        pending = undefined;
        automatic(target);
      });
  }
  function spin() {
    const at = progress();
    const index = Math.min(rows.length - 1, Math.floor(at));
    const fraction = at - index;
    // Retain both visible rows when interrupting a slide; no snapped or clipped
    // word at entry. Each bounded reel passes every other name once, shuffled.
    const head = fraction > .001 && index + 1 < rows.length ? [rows[index]!, rows[index + 1]!] : [rows[index]!];
    const reel: string[] = PROFESSIONS.filter(name => !head.includes(name));
    for (let i = reel.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [reel[i], reel[j]] = [reel[j]!, reel[i]!];
    }
    render([...head, ...reel]);
    const start = head.length === 2 ? fraction : 0;
    const end = rows.length - 1;
    animate('spinning', start, end, 0, (end - start) * SPIN_MS, 'linear', () => {
      if (hovered && !suspended()) spin();
      else automatic(rows[end]!);
    });
  }
  function settle() {
    const at = progress();
    const target = Math.min(rows.length - 1, Math.ceil(at - .001));
    const name = rows[target]!;
    if (Math.abs(target - at) < .001) { automatic(name); return; }
    animate('settling', at, target, 0, Math.max(50, (target - at) * 140), 'cubic-bezier(.22, 1, .36, 1)', () => automatic(name));
  }
  function sync() {
    if (disposed || !animation) return;
    if (suspended()) {
      hovered = false;
      // Rebase to row zero before pausing: reduced-motion CSS removes transforms.
      if (mode !== 'auto' || Number(animation.currentTime) > 0) {
        const name = rows[Math.min(rows.length - 1, Math.round(progress()))]!;
        automatic(name);
      }
      animation.pause();
    } else if (animation.playState !== 'running') animation.play();
  }

  automatic(FIRST_PROFESSION);
  return {
    hover(next: boolean) {
      if (disposed || suspended()) return;
      if (hovered === next) return;
      hovered = next;
      if (hovered) spin();
      else settle();
    },
    sync,
    destroy() { disposed = true; cancel(); element.replaceChildren(); },
  };
}
