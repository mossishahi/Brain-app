import { expect, test, type Page } from '@playwright/test';
import { mockBrain } from './fixtures';

declare global { interface Window { __quickEditorDocument: string } }

const editorChunk = /\/(?:src\/components\/quick-controls\/QuickSettingsEditor\.tsx(?:\?.*)?|assets\/QuickSettingsEditor-[^/]+\.js(?:\?.*)?)$/;
const prompt = (page: Page) => page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });
const trigger = (page: Page) => page.getByRole('button', { name: 'Open settings menu', exact: true });
async function openRecoveryEditor(page: Page) {
  await trigger(page).click();
  await page.getByRole('menuitem', { name: 'Recovery', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Safety buffer…', exact: true }).click();
}

async function observeDocument(page: Page) {
  await page.addInitScript(() => {
    window.__quickEditorDocument = `${Date.now()}-${Math.random()}`;
  });
}

test('a failed optional editor keeps the draft and rail usable and offers explicit Settings', async ({ page }) => {
  const brain = await mockBrain(page);
  await observeDocument(page);
  let attempts = 0;
  await page.route(editorChunk, route => { attempts += 1; return route.abort('failed'); });
  await page.goto('/');
  const documentId = await page.evaluate(() => window.__quickEditorDocument);
  await prompt(page).fill('Keep this draft when an optional editor fails to load.');
  const originalComposer = await prompt(page).elementHandle();
  await openRecoveryEditor(page);
  const fallback = page.getByRole('dialog', { name: 'Editor unavailable', exact: true });
  await expect(fallback).toBeVisible();
  expect(attempts).toBe(1);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('Keep this draft when an optional editor fails to load.');
  expect(await originalComposer!.evaluate(element => element.isConnected)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(fallback).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(await page.evaluate(() => window.__quickEditorDocument)).toBe(documentId);
  await prompt(page).fill('The workspace still accepts edits.');
  await openRecoveryEditor(page);
  await expect(fallback).toBeVisible();
  await fallback.getByRole('button', { name: 'Configure in Settings…', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel('Safety buffer (seconds)', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(prompt(page)).toHaveValue('The workspace still accepts edits.');
  expect(await page.evaluate(() => window.__quickEditorDocument)).toBe(documentId);
  expect(brain.writes.filter(write => write.path === '/settings')).toEqual([]);
});

for (const dismissal of ['outside', 'Escape'] as const) {
  test(`a delayed failed editor stays dismissed after ${dismissal}`, async ({ page }) => {
    await mockBrain(page);
    await observeDocument(page);
    let requested!: () => void;
    const requestStarted = new Promise<void>(resolve => { requested = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    await page.route(editorChunk, async route => { requested(); await released; await route.abort('failed'); });
    await page.goto('/');
    const documentId = await page.evaluate(() => window.__quickEditorDocument);
    await prompt(page).fill('Keep working while the editor is loading.');
    await openRecoveryEditor(page);
    await requestStarted;
    if (dismissal === 'outside') await prompt(page).click();
    else await page.keyboard.press('Escape');
    const failed = page.waitForEvent('requestfailed', request => editorChunk.test(request.url()));
    release();
    await failed;
    // Allow the import rejection and Vite's deferred preload handler to settle.
    await page.waitForTimeout(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(prompt(page)).toHaveValue('Keep working while the editor is loading.');
    await expect(dismissal === 'outside' ? prompt(page) : trigger(page)).toBeFocused();
    expect(await page.evaluate(() => window.__quickEditorDocument)).toBe(documentId);
    await trigger(page).click();
    await expect(page.getByRole('menuitem', { name: 'Appearance', exact: true })).toBeVisible();
  });
}
