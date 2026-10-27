import { expect, test, type Page } from '@playwright/test';
import { type ServerSettingsUpdate } from '@brainstorm-agentic/protocol';
import { mockBrain } from './fixtures';

const browserErrors = new WeakMap<Page, string[]>();

async function openSettings(page: Page, category = 'Models & connections') {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: category, exact: true }).click();
  return dialog;
}

function settingsWrites(page: Page) {
  const writes: ServerSettingsUpdate[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/settings' && request.method() === 'PUT') writes.push(request.postDataJSON());
  });
  return writes;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await mockBrain(page);
  await page.goto('/');
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], 'No uncaught browser errors').toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 900, height: 390 },
  { width: 1080, height: 1920 },
]) {
  test(`settings fits ${viewport.width}×${viewport.height} and retains usable categories`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const dialog = await openSettings(page);
    await expect(dialog.locator('#settings-provider')).toBeVisible();
    const dimensions = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const content = element.querySelector('.settings-content')!;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
        contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth,
        documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    expect(dimensions.x).toBeGreaterThanOrEqual(10);
    expect(dimensions.y).toBeGreaterThanOrEqual(10);
    expect(dimensions.right).toBeLessThanOrEqual(viewport.width - 10);
    expect(dimensions.bottom).toBeLessThanOrEqual(viewport.height - 10);
    expect(dimensions.contentScrollWidth).toBeLessThanOrEqual(dimensions.contentWidth + 1);
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    if (viewport.width === 1440) {
      expect(dimensions.width).toBeGreaterThanOrEqual(1100);
      expect(dimensions.height).toBeLessThanOrEqual(620);
    }
    await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(dialog.getByLabel('Theme', { exact: true })).toBeVisible();
    await expect(dialog.locator('#settings-provider')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Execution', exact: true }).click();
    await expect(dialog.getByLabel('SLURM template', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#canvas-settings-trigger')).toBeFocused();
  });
}

test('typed settings save the final keystroke and closing flushes the debounce', async ({ page }) => {
  const writes = settingsWrites(page);
  const dialog = await openSettings(page, 'Recovery');
  await dialog.getByLabel('Safety buffer (seconds)').fill('123');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes.some((patch) => patch.creditRecovery?.safetyBufferSeconds === 123)).toBe(true);

  await openSettings(page, 'Execution');
  await expect(dialog.getByRole('button', { name: 'Configure GPU execution…', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Time limit per job (minutes)')).toHaveCount(0);
});

test('failed saves remain visible through close and can be corrected', async ({ page }) => {
  let fail = true;
  await page.route('**/api/settings', async (route) => {
    if (fail && route.request().method() === 'PUT') await route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable' } });
    else await route.fallback();
  });
  const dialog = await openSettings(page, 'Recovery');
  await dialog.getByLabel('Safety buffer (seconds)').fill('121');
  await expect(dialog.getByText('Settings temporarily unavailable', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog.getByText(/Some changes could not be saved/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  fail = false;
  await dialog.getByLabel('Safety buffer (seconds)').fill('122');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('credential drafts survive categories and require an explicit discard', async ({ page }) => {
  const writes = settingsWrites(page);
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await dialog.getByLabel('API key', { exact: true }).fill('unsaved-browser-test-key');
  await dialog.getByRole('button', { name: 'Research', exact: true }).click();
  await expect(dialog.locator('#settings-api-key')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('unsaved-browser-test-key');
  await page.keyboard.press('Escape');
  await expect(dialog.getByText(/connection details that have not been saved/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(writes.some((patch) => patch.llm?.apiKey)).toBe(false);
  await dialog.getByRole('button', { name: 'Discard unsaved changes', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#canvas-settings-trigger')).toBeFocused();
});

test('verification never clears a newer credential draft', async ({ page }) => {
  let releaseVerification: (() => void) | undefined;
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT' && route.request().postDataJSON()?.llm?.apiKey) {
      await new Promise<void>((resolve) => { releaseVerification = resolve; });
    }
    await route.fallback();
  });
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  const key = dialog.getByLabel('API key', { exact: true });
  await key.fill('first-browser-test-key');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => Boolean(releaseVerification)).toBe(true);
  await key.fill('newer-browser-test-key');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT' && response.request().postDataJSON()?.llm?.apiKey === 'first-browser-test-key');
  releaseVerification!();
  await completed;
  await expect(dialog.getByText(/^Connected to /)).toHaveCount(0);
  await expect(key).toHaveValue('newer-browser-test-key');
});

test('GPU setup is reviewed through its dialog instead of saving a raw executable template', async ({ page }) => {
  const writes = settingsWrites(page);
  const dialog = await openSettings(page, 'Execution');
  await expect(dialog.getByLabel('GPU job template', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Configure GPU execution…', exact: true }).click();
  const gpu = page.getByRole('dialog', { name: 'GPU execution', exact: true });
  await expect(gpu).toContainText('GPU setup is optional');
  await gpu.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(writes.some(patch => patch.gpu || patch.hostTools?.enabledToolIds.includes('gpu_run'))).toBe(false);
});
