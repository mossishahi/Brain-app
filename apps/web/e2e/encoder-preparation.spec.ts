import { expect, test } from '@playwright/test';
import { mockBrain } from './fixtures';

test('encoder settings report first use, preparation and failure without starting a download', async ({ page }) => {
  const brain = await mockBrain(page);
  let state: 'missing' | 'preparing' | 'prepared' | 'failed' | 'ready' = 'missing';
  const requests: string[] = [];
  await page.route('**/api/panel-composition', route => route.fulfill({ json: { groups: [], params: [], coreKeyConfigured: false } }));
  await page.route('**/api/readiness/encoders', route => {
    requests.push(route.request().method());
    return route.fulfill({ json: { selected: 'specter2', selectedAvailable: state === 'ready', encoders: [
      { id: 'specter2', available: state === 'ready', managed: true, state, detail: state === 'failed' ? 'Download interrupted' : `Model ${state}` },
    ] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Research', exact: true }).click();
  await expect(dialog.getByText(/Opening settings does not start the download/)).toBeVisible();
  state = 'preparing';
  await dialog.getByRole('button', { name: 'Refresh encoder status', exact: true }).click();
  await expect(dialog.getByText(/specter2 is being prepared on this host/)).toBeVisible();
  state = 'prepared';
  await dialog.getByRole('button', { name: 'Refresh encoder status', exact: true }).click();
  await expect(dialog.getByText(/specter2 model files are present/)).toBeVisible();
  state = 'failed';
  await dialog.getByRole('button', { name: 'Refresh encoder status', exact: true }).click();
  await expect(dialog.getByText(/specter2 preparation failed/)).toBeVisible();
  await expect(dialog.getByText(/Download interrupted/)).toBeVisible();
  state = 'ready';
  await dialog.getByRole('button', { name: 'Refresh encoder status', exact: true }).click();
  await expect(dialog.getByText('✓ specter2 (selected) — Model ready', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/specter2 preparation failed/)).toHaveCount(0);
  expect(requests.length).toBeGreaterThanOrEqual(5);
  expect(requests.every(method => method === 'GET')).toBe(true);
  expect(brain.writes.filter(write => write.path.startsWith('/settings'))).toEqual([]);
});
