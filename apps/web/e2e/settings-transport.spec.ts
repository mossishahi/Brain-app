import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultTestSettings, mockBrain } from './fixtures';

async function closeMenus(page: Page) {
  for (let i = 0; i < 4 && await page.getByRole('menu').count(); i += 1) await page.keyboard.press('Escape');
}
async function openDrawer(page: Page) {
  await closeMenus(page);
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}
async function selectGemini(page: Page) {
  await closeMenus(page);
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Models & connections', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Provider', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Gemini API', exact: true }).click();
}

test('a stalled toolbar provider save does not block opening or reading All settings', async ({ page }) => {
  const settings = defaultTestSettings();
  const brain = await mockBrain(page, { settings: { ...settings, llm: { ...settings.llm, geminiApiKeyConfigured: true } } });
  let held: Route | undefined;
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT' && !held) { held = route; return; }
    await route.fallback();
  });
  await page.goto('/');
  await selectGemini(page);
  await expect.poll(() => Boolean(held)).toBe(true);
  const dialog = await openDrawer(page);
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('cursor-agent');
  await expect(dialog.getByText('Loading settings…', { exact: true })).toHaveCount(0);
  // A successful toolbar save reaches the already-open drawer without reload.
  await held!.fallback();
  await expect.poll(() => brain.settings.llm.provider).toBe('gemini');
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('gemini');
});

test('a hung provider request times out, clears pending controls, and can be retried without reload', async ({ page }) => {
  await page.clock.install();
  const settings = defaultTestSettings();
  const brain = await mockBrain(page, { settings: { ...settings, llm: { ...settings.llm, geminiApiKeyConfigured: true } } });
  let held: Route | undefined;
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT' && !held) { held = route; return; }
    await route.fallback();
  });
  await page.goto('/');
  await selectGemini(page);
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.clock.fastForward(90_001);
  await expect(page.getByText(/The save request timed out/).first()).toBeVisible();
  await held!.abort().catch(() => undefined);
  await selectGemini(page);
  await expect.poll(() => brain.settings.llm.provider).toBe('gemini');
  await expect(page.getByText(/The save request timed out/)).toHaveCount(0);
  const dialog = await openDrawer(page);
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('gemini');
});

test('model discovery failure is retryable and background refresh finishes without blocking provider selection', async ({ page }) => {
  await page.clock.install();
  await mockBrain(page);
  let fail = true; let refreshing = false; let reads = 0;
  await page.route('**/api/model-options', async route => {
    reads += 1;
    if (fail) return route.fulfill({ status: 503, json: { error: 'Model discovery is unavailable' } });
    if (refreshing) return route.fulfill({ json: { provider: 'cursor-agent', taskTypes: [], models: [], modelsByRoute: {}, refreshing: true } });
    await route.fallback();
  });
  await page.goto('/');
  const dialog = await openDrawer(page);
  await dialog.getByRole('button', { name: 'Pipeline models', exact: true }).click();
  await expect(dialog.getByText('Model discovery is unavailable', { exact: true })).toBeVisible();
  fail = false; refreshing = true;
  const before = reads;
  await dialog.getByRole('button', { name: 'Retry models', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  refreshing = false;
  await page.clock.fastForward(1_100);
  await expect(dialog.getByText('Model discovery is unavailable', { exact: true })).toHaveCount(0);
  await expect.poll(() => reads).toBeGreaterThan(before + 1);
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await expect(dialog.getByLabel('Provider', { exact: true })).toBeEnabled();
});

test('a stalled initial settings read exposes retry and recovers in the same tab', async ({ page }) => {
  await page.clock.install();
  await mockBrain(page);
  let blocked = true;
  const held: Route[] = [];
  await page.route('**/api/settings', async route => {
    if (blocked && route.request().method() === 'GET') { held.push(route); return; }
    await route.fallback();
  });
  await page.goto('/');
  const dialog = await openDrawer(page);
  // The production drawer is lazy-loaded. Wait for its read to subscribe
  // before advancing the launch request's timer.
  await expect(dialog.getByText('Loading settings…', { exact: true })).toBeVisible();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await page.clock.fastForward(15_001);
  await expect(dialog.getByText(/The settings request timed out/)).toBeVisible();
  await expect(dialog.getByText('Loading settings…', { exact: true })).toHaveCount(0);
  blocked = false;
  await Promise.all(held.map(route => route.abort().catch(() => undefined)));
  await dialog.getByRole('button', { name: 'Retry loading settings', exact: true }).click();
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('cursor-agent');
  await expect(dialog.getByText(/The settings request timed out/)).toHaveCount(0);
});

test('a stalled save response body times out and reconciles an already committed edit without replay', async ({ page }) => {
  await page.clock.install();
  const brain = await mockBrain(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let held = false;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (!held && String(input).endsWith('/settings') && init?.method === 'PUT') {
        held = true;
        return new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Research', exact: true }).click();
  const control = page.getByRole('menuitemcheckbox', { name: 'Continue after countdown', exact: true });
  await control.click();
  await expect.poll(() => brain.settings.gateAutoApprove).toBe(false);
  await expect(control).toHaveAttribute('aria-busy', 'true');
  await page.clock.fastForward(30_001);
  await expect(control).not.toHaveAttribute('aria-busy', 'true');
  await expect(control).toContainText('The save request timed out');
  await expect(control).not.toBeChecked();
  expect(brain.writes.filter(write => write.path === '/settings')).toHaveLength(1);
});
