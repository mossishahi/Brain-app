import { expect, test, type Page } from '@playwright/test';
import { mockBrain } from './fixtures';

const headlineName = 'Got a hunch? Start brainstorming with a mathematician';
const heading = (page: Page) => page.getByRole('heading', { level: 1, name: headlineName, exact: true });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });
const clockStart = new Date('2026-10-03T12:00:00Z');
const headlineTypingMs = (headlineName.length - 1) * 32;
const autoHoldMs = 12_000;
const autoSlideMs = 200;

async function seekProfession(page: Page, milliseconds: number) {
  await page.evaluate((time) => {
    const animation = document.getAnimations().find((item) => item.id === 'research-professions');
    if (!animation) throw new Error('The profession animation was not initialized.');
    animation.pause();
    animation.currentTime = time;
  }, milliseconds);
}

async function finishTurn(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const animation = document.getAnimations().find((item) => item.id === 'research-professions');
    if (!animation) throw new Error('The profession animation was not initialized.');
    animation.finish();
    const nextFrame = () => {
      const next = document.getAnimations().find((item) => item.id === 'research-professions');
      if (!next || next === animation) { requestAnimationFrame(nextFrame); return; }
      next.pause();
      next.currentTime = 0;
      resolve();
    };
    requestAnimationFrame(nextFrame);
  }));
}

const animationState = (page: Page) => page.evaluate(() => {
  const animation = document.getAnimations().find((item) => item.id === 'research-professions');
  return animation ? { state: animation.playState, time: Number(animation.currentTime), duration: Number(animation.effect?.getTiming().duration) } : null;
});

const alignedProfession = (page: Page) => page.locator('.profession-wheel').evaluate((wheel) => {
  const slot = wheel.getBoundingClientRect();
  return [...wheel.querySelectorAll('.profession-option')]
    .filter((row) => Math.abs(row.getBoundingClientRect().y - slot.y) < 1)
    .map((row) => row.querySelector('.profession-name')?.textContent ?? '');
});

const visibleProfessions = (page: Page) => page.locator('.profession-wheel').evaluate((wheel) => {
  const slot = wheel.getBoundingClientRect();
  return [...wheel.querySelectorAll('.profession-option')].filter((row) => {
    const bounds = row.getBoundingClientRect();
    return Math.min(bounds.bottom, slot.bottom) - Math.max(bounds.top, slot.top) > 1;
  }).map((row) => row.querySelector('.profession-name')?.textContent ?? '');
});

async function leaveHeadline(page: Page) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 8, 8);
}

async function expectWholeWordRest(page: Page) {
  await expect(page.locator('.profession-wheel')).toHaveAttribute('data-motion', 'auto');
  await expect.poll(async () => (await animationState(page))?.duration ?? 0).toBeGreaterThan(autoHoldMs);
  await expect.poll(() => alignedProfession(page)).toHaveLength(1);
  expect(await visibleProfessions(page)).toHaveLength(1);
}

async function sampleSpinningNames(page: Page, milliseconds = 450) {
  return page.locator('.profession-wheel').evaluate((wheel, milliseconds) => new Promise<string[]>((resolve) => {
    const names = new Set<string>();
    const started = performance.now();
    const sample = () => {
      const slot = wheel.getBoundingClientRect();
      for (const row of wheel.querySelectorAll('.profession-option')) {
        const bounds = row.getBoundingClientRect();
        if (Math.min(bounds.bottom, slot.bottom) - Math.max(bounds.top, slot.top) > slot.height / 2) {
          names.add(row.querySelector('.profession-name')?.textContent ?? '');
        }
      }
      if (performance.now() - started >= milliseconds) resolve([...names]);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), milliseconds);
}

async function openHome(page: Page, { theme = 'dark', clock = false }: { theme?: 'light' | 'dark'; clock?: boolean } = {}) {
  const brain = await mockBrain(page);
  await page.route('**/api/availability', route => route.fulfill({
    json: { version: 1, updatedAt: Date.now(), tools: [], purposes: [], demoteDegraded: false },
  }));
  await page.addInitScript((theme) => {
    // Reproducible random draws still vary between turns and rounds.
    let seed = 71931;
    Math.random = () => {
      seed = Math.imul(seed, 1664525) + 1013904223 | 0;
      return (seed >>> 0) / 4294967296;
    };
    localStorage.setItem('brain.appearance.v1', JSON.stringify({
      version: 1, preferences: { background: 'none', theme },
    }));
  }, theme);
  if (clock) {
    await page.clock.install({ time: clockStart });
    await page.clock.pauseAt(clockStart);
  }
  await page.goto('/');
  await expect(heading(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return brain;
}

async function openRotatingHome(page: Page) {
  // Motion preference changes must reveal the complete headline immediately.
  // This skips the separate intro for tests concerned only with the wheel.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHome(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
  await expect.poll(() => animationState(page)).not.toBeNull();
  await seekProfession(page, 0);
}

const visibleIntro = (page: Page) => page.locator('.research-headline-prefix, .profession-intro').evaluateAll((elements) => elements.flatMap((element) => [...element.children])
  .filter((letter) => getComputedStyle(letter).visibility !== 'hidden')
  .map((letter) => letter.textContent ?? '').join(''));

test('types the headline immediately once, then starts the logo five seconds later', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openHome(page, { clock: true });
  await expect(heading(page)).toHaveAttribute('data-phase', 'typing');
  expect(await visibleIntro(page)).toBe('G');
  await expect(page.locator('.brand-wordmark-text')).toHaveText('co-inference');
  const viewports = [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }];
  const introLayout: Array<{ headingHeight: number; composerY: number }> = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    introLayout.push({ headingHeight: (await heading(page).boundingBox())!.height, composerY: (await page.locator('.canvas-composer').boundingBox())!.y });
  }
  // Hovering while the sentence types must not cut it short or move the logo's
  // completion-relative start time.
  await page.locator('.profession-wheel').hover();
  await page.clock.runFor(320);
  const partial = await visibleIntro(page);
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(headlineName.length);
  expect(headlineName.startsWith(partial)).toBe(true);
  expect(await animationState(page)).toBeNull();
  await page.clock.runFor(headlineTypingMs - 320 - 1);
  await expect(heading(page)).toHaveAttribute('data-phase', 'typing');
  await expect(page.locator('.brand-wordmark-text')).toHaveText('co-inference');
  await page.clock.runFor(1);
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
  await expect(page.locator('.profession-wheel')).toHaveAttribute('data-motion', 'spinning');
  await leaveHeadline(page);
  for (const [index, viewport] of viewports.entries()) {
    await page.setViewportSize(viewport);
    expect((await heading(page).boundingBox())!.height).toBeCloseTo(introLayout[index]!.headingHeight, 1);
    expect((await page.locator('.canvas-composer').boundingBox())!.y).toBeCloseTo(introLayout[index]!.composerY, 1);
  }
  await page.clock.runFor(4_999);
  await expect(page.locator('.brand-wordmark-text')).toHaveText('co-inference');
  await page.clock.runFor(1);
  await expect(page.locator('.brand-wordmark-text')).toHaveText('');
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
  await page.clock.runFor(60_200);
  await expect(page.locator('.brand-wordmark-text')).toHaveText('i');
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
  // Returning home during the same page lifetime does not replay the intro.
  await page.clock.resume();
  await page.locator('#sidebar-history-trigger').click();
  await page.getByRole('link', { name: 'Open research: Research record 1', exact: true }).click();
  await expect(page.locator('.dash')).toBeVisible();
  await page.getByRole('link', { name: 'New research', exact: true }).click();
  await expect(heading(page)).toBeVisible();
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
});

test('a hidden initial page pauses headline typing and keeps the complete logo until the intro finishes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  });
  await openHome(page, { clock: true });
  await expect(heading(page)).toHaveAttribute('data-phase', 'typing');
  expect(await visibleIntro(page)).toBe('');
  await expect(page.locator('.brand-wordmark-text')).toHaveText('co-inference');
  await page.clock.runFor(60_200);
  expect(await visibleIntro(page)).toBe('');
  await expect(page.locator('.brand-wordmark-text')).toHaveText('co-inference');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await visibleIntro(page)).toBe('G');
  await page.clock.runFor(headlineTypingMs);
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
  await page.clock.runFor(4_999);
  await expect(page.locator('.brand-wordmark-text')).toHaveText('co-inference');
  await page.clock.runFor(1);
  await expect(page.locator('.brand-wordmark-text')).toHaveText('');
});

test('ordinary turns stay readable for twelve seconds before sliding upward', async ({ page }) => {
  await openRotatingHome(page);
  for (let turn = 0; (await animationState(page))?.duration !== autoHoldMs + autoSlideMs && turn < 10; turn++) await finishTurn(page);
  expect((await animationState(page))?.duration).toBe(autoHoldMs + autoSlideMs);
  const rows = page.locator('.profession-option');
  const initial = (await rows.nth(0).boundingBox())!;
  const target = await rows.last().textContent();
  await seekProfession(page, autoHoldMs - 1);
  expect((await rows.nth(0).boundingBox())!.y).toBeCloseTo(initial.y, 1);
  await seekProfession(page, autoHoldMs + autoSlideMs / 2);
  const outgoing = (await rows.nth(0).boundingBox())!;
  const incoming = (await rows.nth(1).boundingBox())!;
  expect(outgoing.y).toBeLessThan(initial.y);
  expect(outgoing.y).toBeGreaterThan(initial.y - initial.height);
  expect(incoming.y).toBeGreaterThan(initial.y);
  expect(incoming.y).toBeLessThan(initial.y + initial.height);
  await finishTurn(page);
  expect(await alignedProfession(page)).toEqual([target]);
  await expect(heading(page)).toHaveAccessibleName(headlineName);
});

test('every expertise gets one resting turn per round, with varied order and occasional visible multi-name passes', async ({ page }) => {
  await openRotatingHome(page);
  const rounds: string[][] = [[], []];
  const distances: number[] = [];
  let inspectedBurst = false;
  for (let turn = 0; turn < 40; turn++) {
    const current = await alignedProfession(page);
    expect(current).toHaveLength(1);
    rounds[Math.floor(turn / 20)]!.push(current[0]!);
    const rows = await page.locator('.profession-name').allTextContents();
    const distance = rows.length - 1;
    distances.push(distance);
    expect(distance).toBeGreaterThanOrEqual(1);
    expect(distance).toBeLessThanOrEqual(4);
    expect(new Set(rows).size).toBe(rows.length);
    expect((await animationState(page))?.duration).toBe(autoHoldMs + distance * autoSlideMs);
    if (distance > 1 && !inspectedBurst) {
      for (let step = 1; step < distance; step++) {
        await seekProfession(page, autoHoldMs + step * autoSlideMs);
        expect(await alignedProfession(page)).toEqual([rows[step]]);
        await seekProfession(page, autoHoldMs + step * autoSlideMs + autoSlideMs / 2);
        expect(await visibleProfessions(page)).toEqual([rows[step], rows[step + 1]]);
      }
      inspectedBurst = true;
    }
    await finishTurn(page);
  }
  expect(new Set(rounds[0]).size).toBe(20);
  expect(new Set(rounds[1]).size).toBe(20);
  expect(new Set(rounds[0])).toEqual(new Set(rounds[1]));
  expect(rounds[1]).not.toEqual(rounds[0]);
  expect(inspectedBurst).toBe(true);
  expect(distances.filter((distance) => distance === 1).length).toBeGreaterThan(20);
  expect(new Set(distances).size).toBeGreaterThan(2);
});

test('hover spins through names rapidly without taking focus, then leaves a complete word for twelve seconds', async ({ page }) => {
  await openRotatingHome(page);
  await prompt(page).fill('Keep this idea ready while exploring other expertise.');
  await page.locator('.profession-wheel').hover();
  await expect(page.locator('.profession-wheel')).toHaveAttribute('data-motion', 'spinning');
  await expect.poll(async () => (await animationState(page))?.duration ?? Infinity).toBeLessThan(autoHoldMs);
  await expect(prompt(page)).toBeFocused();
  const names = await sampleSpinningNames(page);
  expect(names.length).toBeGreaterThanOrEqual(4);
  await page.keyboard.type(' More context.');
  await expect(prompt(page)).toHaveValue('Keep this idea ready while exploring other expertise. More context.');

  await leaveHeadline(page);
  await expectWholeWordRest(page);
  await expect(prompt(page)).toBeFocused();
  const settled = await alignedProfession(page);
  // The next automatic transition gets a fresh hold, including after leaving
  // in the middle of a row rather than at an animation boundary.
  await seekProfession(page, autoHoldMs - 1);
  expect(await alignedProfession(page)).toEqual(settled);
  expect(await visibleProfessions(page)).toEqual(settled);
  await seekProfession(page, autoHoldMs + autoSlideMs / 2);
  expect(await visibleProfessions(page)).toHaveLength(2);
  await finishTurn(page);
  expect(await alignedProfession(page)).not.toEqual(settled);
  await expect(heading(page)).toHaveAccessibleName(headlineName);
});

test('rapid hover reversals cancel old spin work and settle without a delayed restart', async ({ page }) => {
  await openRotatingHome(page);
  const wheel = page.locator('.profession-wheel');
  await prompt(page).fill('The draft survives repeated hovering.');
  for (let pass = 0; pass < 5; pass++) {
    await wheel.hover();
    await page.waitForTimeout(25 + pass * 11);
    await leaveHeadline(page);
    // Re-enter before the previous partial row can finish settling.
    if (pass < 4) await page.waitForTimeout(15);
  }
  await expectWholeWordRest(page);
  const settled = await alignedProfession(page);
  await page.waitForTimeout(600);
  expect(await alignedProfession(page)).toEqual(settled);
  expect(await visibleProfessions(page)).toEqual(settled);
  expect((await animationState(page))?.duration).toBeGreaterThan(autoHoldMs);
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.id === 'research-professions').length)).toBe(1);
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('The draft survives repeated hovering.');

  // A later deliberate hover still spins: stopping must not permanently
  // disable the interaction or require a click to restart it.
  await wheel.hover();
  expect((await sampleSpinningNames(page, 360)).length).toBeGreaterThanOrEqual(3);
  await leaveHeadline(page);
  await expectWholeWordRest(page);
});

test('short names stay next to the sentence with no colon or leading gap at phone and desktop sizes', async ({ page }) => {
  await openRotatingHome(page);
  await expect(page.locator('.research-headline-colon')).toHaveCount(0);
  const wheel = page.locator('.profession-wheel');
  for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    const initialWheel = (await wheel.boundingBox())!;
    const initialComposer = (await page.locator('.canvas-composer').boundingBox())!;
    for (let turn = 0; turn < 20; turn++) {
      const geometry = await wheel.evaluate((element) => {
        const slot = element.getBoundingClientRect();
        const name = element.querySelector('.profession-name')!.getBoundingClientRect();
        return { x: slot.x, y: slot.y, width: slot.width, nameX: name.x, nameRight: name.right, right: slot.right };
      });
      expect(geometry.nameX).toBeCloseTo(geometry.x, 1);
      expect(geometry.nameRight).toBeLessThanOrEqual(geometry.right + 1);
      expect(geometry.x).toBeCloseTo(initialWheel.x, 1);
      expect(geometry.y).toBeCloseTo(initialWheel.y, 1);
      expect(geometry.width).toBeCloseTo(initialWheel.width, 1);
      expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
      expect((await page.locator('.canvas-composer').boundingBox())!.y).toBeCloseTo(initialComposer.y, 1);
      await finishTurn(page);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    if (viewport.width === 1440) {
      const geometry = await heading(page).evaluate((element) => {
        const prefix = element.querySelector('.research-headline-prefix')!.getBoundingClientRect();
        const wheel = element.querySelector('.profession-wheel')!.getBoundingClientRect();
        return { gap: wheel.x - prefix.right, height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight) };
      });
      expect(geometry.gap).toBeGreaterThanOrEqual(-1);
      expect(geometry.gap).toBeLessThan(12);
      expect(geometry.height).toBeLessThanOrEqual(geometry.line + 1);
    }
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} theme keeps the writing surface near-black on focus and removes the helper copy`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const brain = await openHome(page, { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByText('Start with a question, an idea, or material you want to explore.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Enter to explore', { exact: false })).toHaveCount(0);
    const surface = page.locator('.canvas-composer');
    await heading(page).click();
    const before = await surface.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, shadow: style.boxShadow };
    });
    const channels = before.background.match(/\d+/g)!.map(Number);
    expect(channels.slice(0, 3).every((channel) => channel < 25)).toBe(true);
    await prompt(page).click();
    await prompt(page).fill('A draft stays accessible while the surface remains dark.');
    await page.waitForTimeout(250);
    const after = await surface.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, shadow: style.boxShadow };
    });
    expect(after).toEqual(before);
    const textColor = await prompt(page).evaluate((element) => getComputedStyle(element).color);
    expect(textColor.match(/\d+/g)!.slice(0, 3).map(Number).every((channel) => channel > 200)).toBe(true);
    await expect(prompt(page)).toHaveValue('A draft stays accessible while the surface remains dark.');
    expect(brain.writes.filter((request) => request.path === '/jobs')).toHaveLength(0);
    expect(brain.unhandled).toEqual([]);
  });
}

test('reduced motion shows the complete headline immediately and disables typing and rotation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHome(page);
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
  await expect(heading(page)).toHaveAccessibleName(headlineName);
  await expect(page.locator('.brand-wordmark-text')).toHaveText('co-inference');
  const first = await visibleProfessions(page);
  expect(first).toEqual(['mathematician']);
  expect((await animationState(page))?.state ?? 'paused').toBe('paused');
  await page.locator('.profession-wheel').hover();
  await page.waitForTimeout(300);
  expect(await visibleProfessions(page)).toEqual(first);
  expect((await animationState(page))?.state ?? 'paused').toBe('paused');
  await leaveHeadline(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(async () => (await animationState(page))?.state).toBe('running');
  await seekProfession(page, autoHoldMs + autoSlideMs / 2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await animationState(page))?.state ?? 'paused').toBe('paused');
  expect(await visibleProfessions(page)).toHaveLength(1);
  await page.locator('.profession-wheel').hover();
  const reduced = await visibleProfessions(page);
  await page.waitForTimeout(300);
  expect(await visibleProfessions(page)).toEqual(reduced);
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
});

test('hidden documents and inactive home views suspend motion at a complete word', async ({ page }) => {
  await openRotatingHome(page);
  await page.locator('.profession-wheel').hover();
  await expect(page.locator('.profession-wheel')).toHaveAttribute('data-motion', 'spinning');
  await page.waitForTimeout(65);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await animationState(page))?.state).toBe('paused');
  await expect(page.locator('.profession-wheel')).toHaveAttribute('data-motion', 'auto');
  expect(await alignedProfession(page)).toHaveLength(1);
  const hidden = await animationState(page);
  await page.waitForTimeout(450);
  expect(await animationState(page)).toEqual(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await animationState(page))?.state).toBe('running');
  await expectWholeWordRest(page);
  await leaveHeadline(page);
  await page.locator('.profession-wheel').hover();
  await expect(page.locator('.profession-wheel')).toHaveAttribute('data-motion', 'spinning');
  // Navigation can come from browser history or another control without the
  // pointer first leaving the word. The hidden home must still stop its reel.
  await page.evaluate(() => { location.hash = '/jobs/test-run-1'; });
  await expect(page.locator('.dash')).toBeVisible();
  await expect.poll(async () => (await animationState(page))?.state).toBe('paused');
  await expect(page.locator('.profession-wheel')).toHaveAttribute('data-motion', 'auto');
  const paused = await animationState(page);
  await page.waitForTimeout(450);
  expect(await animationState(page)).toEqual(paused);
  await page.getByRole('link', { name: 'New research', exact: true }).click();
  await expect(heading(page)).toHaveAttribute('data-phase', 'rotating');
  await expect.poll(async () => (await animationState(page))?.state).toBe('running');
  await expectWholeWordRest(page);
});
