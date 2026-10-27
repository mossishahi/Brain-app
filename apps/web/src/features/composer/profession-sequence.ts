export const PROFESSIONS = [
  'mathematician', 'chemist', 'physician', 'physicist', 'biologist',
  'statistician', 'philosopher', 'neuroscientist', 'geneticist', 'geologist',
  'psychologist', 'sociologist', 'computer scientist', 'data scientist',
  'materials scientist', 'climate scientist', 'cognitive scientist',
  'systems researcher', 'robotics researcher', 'bioinformatician',
] as const;
export const FIRST_PROFESSION = PROFESSIONS[0];

/** Stops are balanced independently of the brief names passed during a burst. */
export function createProfessionSequence(random: () => number = Math.random) {
  const shuffled = (values: readonly string[]) => {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };
  // The initial typed mathematician already counts as the first settled name.
  let stops = shuffled(PROFESSIONS.slice(1));
  let first = true;
  let lastWasBurst = false;
  let recent = [FIRST_PROFESSION as string];
  return (current: string): string[] => {
    if (stops.length === 0) {
      stops = shuffled(PROFESSIONS);
      if (stops[0] === current) [stops[0], stops[1]] = [stops[1]!, stops[0]!];
    }
    const target = stops.shift()!;
    const burst = !first && !lastWasBurst && random() < .25;
    const distance = burst ? 2 + Math.floor(random() * 3) : 1;
    const intermediates = distance > 1
      ? shuffled(PROFESSIONS.filter(name => name !== current && name !== target && !recent.includes(name))).slice(0, distance - 1)
      : [];
    first = false;
    lastWasBurst = burst;
    recent = [...recent, ...intermediates, target].slice(-6);
    return [current, ...intermediates, target];
  };
}
