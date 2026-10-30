import { expect, test, type Page } from '@playwright/test';
import { GPU_COMMAND_TAG } from '@brainstorm-agentic/protocol';
import { defaultTestSettings, mockBrain } from './fixtures';

const question = (page: Page) => page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });
const item = (page: Page, label: string) => page.getByRole('menuitem', { name: label, exact: true });
const toggle = (page: Page, label: string) => page.getByRole('menuitemcheckbox', { name: label, exact: true });
const choice = (page: Page, label: string) => page.getByRole('menuitemradio', { name: label, exact: true });
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Open settings menu', exact: true })).toBeVisible();
}

async function openCategory(page: Page, label: string) {
  await openMenu(page);
  await item(page, label).click();
}

/** Hold exactly one PUT so rapid sibling edits exercise the real client queue. */
async function holdNextSave(page: Page) {
  let held = false;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings', async route => {
    if (!held && route.request().method() === 'PUT') {
      held = true;
      await ready;
    }
    await route.fallback();
  });
  return { wait: () => expect.poll(() => held).toBe(true), release };
}

test('all settings categories open menus and retain the current workspace', async ({ page }) => {
  const brain = await mockBrain(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await question(page).fill('Keep this research draft while changing preferences.');
  const composer = await question(page).elementHandle();
  const before = await question(page).boundingBox();
  for (const label of ['Models & connections', 'Stage models', 'Research', 'Tools & sources', 'Execution', 'Recovery', 'App updates', 'Appearance']) {
    await openCategory(page, label);
    await expect(page.getByRole('menu', { name: label, exact: true })).toBeVisible();
    await expect(settingsDialog(page)).toHaveCount(0);
    await expect(question(page)).toHaveValue('Keep this research draft while changing preferences.');
    expect(await composer!.evaluate(node => node.isConnected)).toBe(true);
    expect(await question(page).boundingBox()).toEqual(before);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  expect(brain.writes.filter(write => write.path === '/settings')).toEqual([]);
  expect(errors).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('a toggle saves in place and failed changes revert with visible feedback', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  await openCategory(page, 'Research');
  const countdown = toggle(page, 'Continue after countdown');
  await expect(countdown).toBeChecked();
  await countdown.click();
  await expect.poll(() => brain.settings.gateAutoApprove).toBe(false);
  await expect(countdown).not.toBeChecked();
  await expect(page.getByRole('menu', { name: 'Research', exact: true })).toBeVisible();
  brain.failSettings = 'The update could not be saved. Try again.';
  await countdown.click();
  await expect(countdown).toContainText('The update could not be saved. Try again.');
  await expect(countdown).not.toBeChecked();
  expect(brain.settings.gateAutoApprove).toBe(false);
  brain.failSettings = false;
  await countdown.click();
  await expect.poll(() => brain.settings.gateAutoApprove).toBe(true);
  await expect(countdown).toBeChecked();
  await expect(countdown).not.toContainText('could not be saved');
  await expect(settingsDialog(page)).toHaveCount(0);
});

test('closing the menu does not cancel a pending settings save', async ({ page }) => {
  const brain = await mockBrain(page);
  const save = await holdNextSave(page);
  await page.goto('/');
  await openCategory(page, 'Research');
  await toggle(page, 'Continue after countdown').click();
  await save.wait();
  await expect(toggle(page, 'Continue after countdown')).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  save.release();
  await expect.poll(() => brain.settings.gateAutoApprove).toBe(false);
  await openCategory(page, 'Research');
  await expect(toggle(page, 'Continue after countdown')).not.toBeChecked();
  await expect(toggle(page, 'Continue after countdown')).not.toHaveAttribute('aria-busy', 'true');
});

test('rapid panel edits preserve the selected size and interdisciplinary policy', async ({ page }) => {
  const brain = await mockBrain(page);
  const save = await holdNextSave(page);
  await page.goto('/');
  await openCategory(page, 'Research');
  await item(page, 'Panel size').click();
  await choice(page, '6 seats').click();
  await save.wait();
  await page.keyboard.press('Escape');
  await toggle(page, 'Interdisciplinary seat').click();
  save.release();
  await expect.poll(() => brain.settings.panel).toEqual({ size: 6, interdisciplinarySeat: false });
  const writes = brain.writes.filter(write => write.path === '/settings');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.body.panel).toEqual({ size: 6, interdisciplinarySeat: false });
});

test('rapid agent edits preserve effort, thinking and existing task limits', async ({ page }) => {
  const brain = await mockBrain(page);
  const save = await holdNextSave(page);
  await page.goto('/');
  await openCategory(page, 'Models & connections');
  await item(page, 'Reasoning effort').click();
  await choice(page, 'Low').click();
  await save.wait();
  await page.keyboard.press('Escape');
  await toggle(page, 'Extended thinking').click();
  save.release();
  await expect.poll(() => brain.settings.llm.agentSdk).toEqual({ maxTurns: 80, effort: 'low', thinking: 'disabled' });
  const writes = brain.writes.filter(write => write.path === '/settings');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.body.llm.agentSdk).toEqual({ maxTurns: 80, effort: 'low', thinking: 'disabled' });
});

test('rapid host-tool edits retain GPU configuration and unrelated tool permissions', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.gpu = { template: `#!/bin/bash\n${GPU_COMMAND_TAG}`, timeLimitMinutes: 45 };
  settings.hostTools = { enabledToolIds: ['attachment_list', 'attachment_read', 'attachment_search', 'gpu_run', 'custom_tool'] };
  const brain = await mockBrain(page, { settings });
  const save = await holdNextSave(page);
  await page.goto('/');
  await openCategory(page, 'Tools & sources');
  await toggle(page, 'Attachment access').click();
  await save.wait();
  await toggle(page, 'Host code execution').click();
  save.release();
  await expect.poll(() => brain.settings.hostTools?.enabledToolIds).toEqual(['gpu_run', 'custom_tool', 'code_execute']);
  expect(brain.settings.gpu).toEqual(settings.gpu);
  await expect(toggle(page, 'Host code execution')).toBeChecked();
  await expect(toggle(page, 'Attachment access')).not.toBeChecked();
});

test('host-only search controls explain when agent-native search makes them inactive', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  await openCategory(page, 'Tools & sources');
  await item(page, 'Search tools').click();
  await choice(page, 'Agent-native tools').click();
  await expect.poll(() => brain.settings.webSearch?.mode).toBe('agent');
  await page.keyboard.press('Escape');
  await expect(toggle(page, 'Scholarly indexes')).toBeDisabled();
  await expect(toggle(page, 'Cache search results')).toBeDisabled();
  await expect(item(page, 'Search provider')).toBeDisabled();
  expect(brain.settings.webSearch?.searxngBaseUrl).toBe('https://search.example.test');
  expect(brain.settings.webSearch?.braveFallback?.maxRequestsPerMonth).toBe(1000);
});

test('an unconfigured provider opens connection setup without changing the active provider', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  await openCategory(page, 'Models & connections');
  await item(page, 'Provider').click();
  await item(page, 'Anthropic API…').click();
  await expect(settingsDialog(page)).toBeVisible();
  await expect(settingsDialog(page).getByRole('heading', { name: 'Models & connections', exact: true })).toBeVisible();
  expect(brain.settings.llm.provider).toBe('cursor-agent');
  expect(brain.writes.filter(write => write.path === '/settings')).toEqual([]);
});

test('numeric editor rejects invalid limits and applies a validated group without opening Settings', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  await openCategory(page, 'Models & connections');
  await item(page, 'Task limits & fallback…').click();
  const editor = page.getByRole('dialog', { name: 'Task limits & fallback', exact: true });
  await expect(editor).toBeVisible();
  const turns = editor.getByLabel('Maximum turns', { exact: true });
  await turns.fill('0');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  expect(await turns.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(false);
  expect(brain.writes.filter(write => write.path === '/settings')).toEqual([]);
  await expect(editor).toBeVisible();
  await turns.fill('120');
  await editor.getByLabel('Maximum USD per task', { exact: true }).fill('2.50');
  await editor.getByLabel('Fallback model', { exact: true }).fill('fallback-for-test');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect.poll(() => brain.settings.llm.agentSdk).toEqual({ maxTurns: 120, effort: 'high', thinking: 'adaptive', maxBudgetUsd: 2.5, fallbackModel: 'fallback-for-test' });
  await expect(settingsDialog(page)).toHaveCount(0);
});

test('keyboard arrows open nested choices and Escape closes one tier at a time', async ({ page }) => {
  await mockBrain(page);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Open settings menu', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await item(page, 'Research').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menu', { name: 'Research', exact: true })).toBeVisible();
  await item(page, 'Review rounds').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menu', { name: 'Review rounds', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Review rounds', exact: true })).not.toBeVisible();
  await expect(item(page, 'Review rounds')).toBeFocused();
  await expect(page.getByRole('menu', { name: 'Research', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Research', exact: true })).not.toBeVisible();
  await expect(item(page, 'Research')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('All settings retains explicit navigation and uses switches for every boolean preference', async ({ page }) => {
  await mockBrain(page);
  await page.goto('/');
  await openMenu(page);
  await item(page, 'All settings…').click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  for (const label of ['Research', 'Tools & sources', 'Recovery', 'Appearance']) {
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog.getByRole('switch').first()).toBeVisible();
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
  }
  await dialog.getByRole('button', { name: 'Tools & sources', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: 'Web Search', exact: true })).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Code Execution', exact: true })).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Taxonomy Access (always on)', exact: true })).toBeDisabled();
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test.describe('touch quick controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('phone tiers use one floating menu with Back and preserve the main workspace', async ({ page }) => {
    const brain = await mockBrain(page);
    await page.goto('/');
    await question(page).fill('A phone draft that must remain mounted.');
    const composer = await question(page).elementHandle();
    await openCategory(page, 'Research');
    await expect(page.getByRole('menu')).toHaveCount(1);
    await item(page, 'Panel size').tap();
    await choice(page, '6 seats').tap();
    await expect.poll(() => brain.settings.panel?.size).toBe(6);
    await item(page, 'Back').tap();
    await expect(toggle(page, 'Interdisciplinary seat')).toBeVisible();
    await toggle(page, 'Interdisciplinary seat').tap();
    await expect.poll(() => brain.settings.panel?.interdisciplinarySeat).toBe(false);
    await item(page, 'Back').tap();
    await expect(item(page, 'Appearance')).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(1);
    await expect(settingsDialog(page)).toHaveCount(0);
    expect(await composer!.evaluate(node => node.isConnected)).toBe(true);
    await expect(question(page)).toHaveValue('A phone draft that must remain mounted.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await page.getByRole('menu').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  });
});
