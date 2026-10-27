import { expect, test } from '@playwright/test';
import { mockBrain } from './fixtures';

test('settings and navigation work with a disconnected server and a malformed deep link', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }));
  await page.goto('/#/jobs/%E0%A4%A');
  await expect(page.getByRole('textbox', { name: 'What do you want to think through?' })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByLabel('Theme', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('complementary', { name: 'Research library', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search research history', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('opening and closing settings preserves an active research view and the unfinished home draft', async ({ page }) => {
  await mockBrain(page);
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'What do you want to think through?' });
  await input.fill('Unfinished question stays here');
  await page.getByRole('button', { name: 'Research history', exact: true }).click();
  await page.locator('a[href="#/jobs/test-run-1"]').first().click();
  await expect(page).toHaveURL(/#\/jobs\/test-run-1(?:\?|$)/);
  await expect(page.locator('.dash')).toBeVisible();
  const heading = await page.locator('.dash-title').textContent();
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.dash-title')).toHaveText(heading!);
  await page.getByRole('link', { name: 'New research', exact: true }).click();
  await expect(input).toHaveValue('Unfinished question stays here');
});
