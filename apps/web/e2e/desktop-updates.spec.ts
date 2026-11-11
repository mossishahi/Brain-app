import { expect, test, type Page } from '@playwright/test';
import { mockBrain } from './fixtures';

async function desktop(page: Page, nativeUpdates?: 'macos-menu' | 'unavailable') {
  await page.addInitScript((mode) => {
    window.__CO_INFERENCE_LAUNCHER__ = { version: 1, ...(mode ? { nativeUpdates: mode } : {}) };
  }, nativeUpdates);
}

async function openUpdates(page: Page) {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'App updates', exact: true }).click();
  return page.getByRole('menu', { name: 'App updates', exact: true });
}

function health(version = '0.2.91') {
  return { ok: true, version, workspace: '/test-workspace',
    appUpdate: { version: '0.3.0', notes: 'Source-only application release notes' },
    contentRegistry: { running: true, url: 'https://registry.example.test/mcp', bundle: 'brainstorm', latest: '0.31.0', latestNotes: 'Updated research skills', effectiveVersion: '0.31.0' } };
}

test('Mac desktop settings point to the native updater and never call the research service updater', async ({ page }) => {
  await desktop(page, 'macos-menu');
  const brain = await mockBrain(page);
  await page.route('**/api/health', route => route.fulfill({ json: health() }));
  await page.goto('/');
  const updates = await openUpdates(page);
  await expect(updates.getByRole('menuitem', { name: 'Desktop updates…', exact: true })).toBeVisible();
  await expect(updates.getByRole('menuitem', { name: 'Check for updates', exact: true })).toHaveCount(0);
  await expect(updates.getByRole('menuitemcheckbox', { name: 'Notify about app updates', exact: true })).toHaveCount(0);
  await updates.getByRole('menuitem', { name: 'Desktop updates…', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('heading', { name: 'Desktop updates', exact: true })).toBeVisible();
  await expect(settings.getByText('Co-inference → Check for Updates…', { exact: true })).toBeVisible();
  await expect(settings).toContainText('bring the Co-inference app to the front');
  await expect(settings).toContainText('You do not need to download a DMG yourself');
  await expect(settings.getByRole('button', { name: 'Check for updates', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('combobox', { name: 'automatic update checks', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await openUpdates(page);
  await page.getByRole('menuitem', { name: 'Research service & registry information…', exact: true }).click();
  const info = page.getByRole('dialog', { name: 'Research service & registry information', exact: true });
  await expect(info.locator('dt', { hasText: /^Research service$/ })).toBeVisible();
  await expect(info.locator('dt', { hasText: /^App$/ })).toHaveCount(0);
  await expect(info).toContainText('0.2.91');
  await info.getByText('Skills release notes', { exact: true }).click();
  await expect(info).toContainText('Updated research skills');
  await expect(info).not.toContainText('Source-only application release notes');
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toHaveCount(0);
  expect(brain.writes.filter(write => write.path === '/update-check' || write.path === '/update')).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

for (const mode of ['unavailable', undefined] as const) {
  test(`launcher update guidance is accurate when native support is ${mode ?? 'unknown'}`, async ({ page }) => {
    await desktop(page, mode);
    const brain = await mockBrain(page);
    await page.goto('/');
    const updates = await openUpdates(page);
    await updates.getByRole('menuitem', { name: 'Desktop updates…', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    if (mode === 'unavailable') {
      await expect(settings).toContainText('This launcher installation is updated by its deployment owner');
      await expect(settings).not.toContainText('macOS menu bar');
    } else {
      await expect(settings).toContainText('If you use Co-inference for Mac');
      await expect(settings).toContainText('Other launcher installations are updated by their deployment owner');
    }
    await expect(settings.getByRole('button', { name: 'Check for updates', exact: true })).toHaveCount(0);
    expect(brain.writes.filter(write => write.path.startsWith('/update'))).toEqual([]);
  });
}

test('desktop health polling retains skills notices and refreshes the connection without claiming to update the bundled interface', async ({ page }) => {
  await page.clock.install();
  await desktop(page, 'macos-menu');
  await page.addInitScript(() => {
    localStorage.setItem('brain-acked-bundle-version', '0.30.0');
    sessionStorage.setItem('brain-update-success', JSON.stringify({ to: '0.2.90' }));
  });
  const brain = await mockBrain(page);
  let version = '0.2.90', polls = 0;
  await page.route('**/api/health', route => { polls++; return route.fulfill({ json: health(version) }); });
  await page.goto('/');
  await expect(page.getByText('Brain skills updated: brainstorm v0.31.0', { exact: true })).toBeVisible();
  await expect(page.getByText('Update complete', { exact: true })).toHaveCount(0);
  const initialPolls = polls;
  version = '0.2.91';
  await page.clock.fastForward(61_000);
  await expect.poll(() => polls).toBeGreaterThan(initialPolls);
  await expect(page.getByText('The research service now runs v0.2.91', { exact: true })).toBeVisible();
  await expect(page.getByText('Reload to refresh this research connection. Your app’s interface is updated separately.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload now', exact: true })).toBeVisible();
  await expect(page.getByText(/reload to get the matching one/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('brain-check-updates')));
  expect(brain.writes.filter(write => write.path.startsWith('/update'))).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('browser installations retain real checks in quick and full settings with neutral result wording', async ({ page }) => {
  await mockBrain(page);
  let checks = 0, enabled = true;
  await page.route('**/api/update-check', route => { checks++; return route.fulfill({ json: { version: '0.2.91', selfUpdateEnabled: enabled } }); });
  await page.goto('/');
  await expect.poll(() => checks).toBeGreaterThan(0);
  const updates = await openUpdates(page);
  const initialChecks = checks; // Development StrictMode can mount the shell twice.
  await expect(updates.getByRole('menuitemcheckbox', { name: 'Notify about app updates', exact: true })).toBeVisible();
  await expect(updates.getByRole('menuitem', { name: 'Desktop updates…', exact: true })).toHaveCount(0);
  await updates.getByRole('menuitem', { name: 'Check for updates', exact: true }).click();
  await expect.poll(() => checks).toBe(initialChecks + 1);
  await expect(updates).toContainText('No newer release was reported. Running v0.2.91.');
  enabled = false;
  await updates.getByRole('menuitem', { name: /^Check for updates/ }).click();
  await expect(updates).toContainText('This research service is managed by its installation; browser updates are unavailable here.');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'App updates', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'automatic update checks', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect.poll(() => checks).toBe(initialChecks + 3);
  await expect(settings).toContainText('This research service is managed by its installation; browser updates are unavailable here.');
  await expect(settings).not.toContainText('--no-self-update');
  enabled = true;
  await settings.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(settings).toContainText('No newer release was reported. Running v0.2.91.');
});

test('browser installations retain the source update install action', async ({ page }) => {
  await mockBrain(page);
  await page.route('**/api/health', route => route.fulfill({ json: health() }));
  let installs = 0;
  await page.route('**/api/update', route => { installs++; return route.fulfill({ json: { updatingTo: '0.3.0' } }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Updating to v0.3.0…', exact: true })).toBeVisible();
  expect(installs).toBe(1);
});
