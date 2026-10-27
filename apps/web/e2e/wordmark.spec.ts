import { expect, test, type Page } from '@playwright/test';
import { mockBrain } from './fixtures';

const clockStart = new Date('2026-10-03T12:00:00Z');
const headlineTypingMs = ('Got a hunch? Start brainstorming with a mathematician'.length - 1) * 32;
const wordmark = (page: Page) => page.locator('.brand-wordmark-text');
const home = (page: Page) => page.getByRole('link', { name: 'co-inference home', exact: true });

async function openWithClock(page: Page) {
  await mockBrain(page);
  await page.addInitScript(() => {
    // The wordmark has its own timing; avoid scheduling unrelated canvas frames.
    localStorage.setItem('brain.appearance.v1', JSON.stringify({
      version: 1, preferences: { background: 'none', theme: 'dark' },
    }));
  });
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  await page.goto('/');
  await expect(home(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('starts five seconds after the headline, types and deletes inference, and repeats every minute', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openWithClock(page);
  const text = wordmark(page);
  const width = (await page.locator('.brand-wordmark').boundingBox())!.width;
  const headerLink = (await home(page).boundingBox())!;
  await expect(page.getByText('Research, in one place.', { exact: true })).toHaveCount(0);
  expect(width).toBeGreaterThan(0);
  await expect(page.locator('.brand-wordmark')).toHaveAttribute('aria-hidden', 'true');

  let elapsed = 0;
  async function at(time: number, value: string) {
    await page.clock.runFor(time - elapsed);
    elapsed = time;
    await expect(text).toHaveText(value);
    await expect(home(page)).toHaveAccessibleName('co-inference home');
    expect((await page.locator('.brand-wordmark').boundingBox())!.width).toBeCloseTo(width, 2);
    const link = (await home(page).boundingBox())!;
    expect(link.x).toBeCloseTo(headerLink.x, 2);
    expect(link.width).toBeCloseTo(headerLink.width, 2);
  }

  await at(0, 'co-inference');
  await at(headlineTypingMs, 'co-inference');
  await expect(page.locator('.research-headline')).toHaveAttribute('data-phase', 'rotating');
  const cycleStart = headlineTypingMs + 5_000;
  await at(cycleStart - 1, 'co-inference');
  await at(cycleStart, '');
  await at(cycleStart + 199, '');
  for (let letters = 1; letters <= 'inference'.length; letters += 1) {
    await at(cycleStart + 200 + (letters - 1) * 105, 'inference'.slice(0, letters));
  }
  await at(cycleStart + 1889, 'inference');
  for (let letters = 8; letters >= 0; letters -= 1) {
    await at(cycleStart + 1890 + (8 - letters) * 65, 'inference'.slice(0, letters));
  }
  await at(cycleStart + 2660, 'c');
  await at(cycleStart + 2770, 'co');
  await at(cycleStart + 2880, 'co-');
  await at(cycleStart + 3879, 'co-');
  for (let letters = 1; letters <= 'inference'.length; letters += 1) {
    await at(cycleStart + 3880 + (letters - 1) * 105, `co-${'inference'.slice(0, letters)}`);
  }
  await at(cycleStart + 59_999, 'co-inference');
  await at(cycleStart + 60_000, '');
  await at(cycleStart + 60_200, 'i');
});

test('reduced motion presents the complete accessible name and stops an in-progress animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWithClock(page);
  await expect(wordmark(page)).toHaveText('co-inference');
  await page.clock.runFor(60_500);
  await expect(wordmark(page)).toHaveText('co-inference');
  await expect(home(page)).toHaveAccessibleName('co-inference home');

  // CDP can return before matchMedia dispatches its change event. Keep the
  // virtual clock still until the application receives that preference.
  await page.evaluate(() => {
    const state = window as Window & { motionPreferenceChanged?: Promise<void> };
    state.motionPreferenceChanged = new Promise(resolve => {
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => queueMicrotask(resolve), { once: true });
    });
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => (window as Window & { motionPreferenceChanged?: Promise<void> }).motionPreferenceChanged);
  await expect(wordmark(page)).toHaveText('co-inference');
  await page.clock.runFor(4_999);
  await expect(wordmark(page)).toHaveText('co-inference');
  await page.clock.runFor(1);
  await expect(wordmark(page)).toHaveText('');
  await page.clock.runFor(410);
  await expect(wordmark(page)).toHaveText('inf');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(wordmark(page)).toHaveText('co-inference');
  await page.clock.runFor(60_500);
  await expect(wordmark(page)).toHaveText('co-inference');
});

test('the complete wordmark remains visible on narrow portrait and landscape screens', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWithClock(page);
  for (const viewport of [{ width: 320, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expect(wordmark(page)).toBeVisible();
    await expect(wordmark(page)).toHaveText('co-inference');
    const bounds = (await wordmark(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  // Let React's lazy-view reveal delay elapse normally for this layout check.
  await page.clock.resume();
  await page.goto('/#/jobs/test-run-1');
  await expect(page.locator('.dash')).toBeVisible();
  const history = page.locator('.canvas-topbar').getByRole('button', { name: 'Research history', exact: true });
  await expect(history).toBeVisible();
  const historyBounds = (await history.boundingBox())!;
  const nameBounds = (await home(page).boundingBox())!;
  expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(historyBounds.x);
  expect(historyBounds.x + historyBounds.width).toBeLessThanOrEqual(320);
});
