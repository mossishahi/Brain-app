import { expect, test, type Page } from '@playwright/test';
import { defaultTestSettings, mockBrain } from './fixtures';

async function openSettings(page: Page, category = 'Models & connections') {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: category, exact: true }).click();
  return dialog;
}

test('a failed refresh keeps saved settings editable and retries without reloading the page', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  await expect.poll(() => brain.requests.filter(request => request.path === '/settings').length).toBeGreaterThan(0);
  let rejectRead = true;
  await page.route('**/api/settings', async route => {
    if (rejectRead && route.request().method() === 'GET') return route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable' } });
    return route.fallback();
  });
  const dialog = await openSettings(page);
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('cursor-agent');
  await expect(dialog.getByRole('alert')).toContainText('Your last saved settings and drafts are still available');
  await dialog.getByLabel('Provider', { exact: true }).selectOption('claude-agent');
  await dialog.getByLabel('Setup token', { exact: true }).fill('local-unsaved-test-token');
  rejectRead = false;
  await dialog.getByRole('button', { name: 'Retry loading settings', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry loading settings', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('claude-agent');
  await expect(dialog.getByLabel('Setup token', { exact: true })).toHaveValue('local-unsaved-test-token');
  expect(brain.writes.filter(write => write.path === '/settings')).toHaveLength(0);
});

test('the drawer follows saved changes while preserving unsaved connection drafts', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider', { exact: true }).selectOption('claude-agent');
  await dialog.getByLabel('Setup token', { exact: true }).fill('local-credential-draft');
  brain.settings = { ...brain.settings, review: { maxRounds: 7 } };
  await page.evaluate(settings => window.dispatchEvent(new CustomEvent('brain-settings-updated', { detail: settings })), brain.settings);
  await expect(dialog.getByLabel('Setup token', { exact: true })).toHaveValue('local-credential-draft');
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('claude-agent');
  await dialog.getByRole('button', { name: 'Research', exact: true }).click();
  await expect(dialog.locator('#settings-review-rounds')).toHaveValue('7');
  expect(brain.writes.filter(write => write.path === '/settings')).toHaveLength(0);
});

test('failed autosaves retry the same draft without retyping it', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  const dialog = await openSettings(page, 'Recovery');
  brain.failSettings = 'The settings service could not save this change.';
  await dialog.getByLabel('Safety buffer (seconds)').fill('123');
  await expect(dialog.getByRole('alert')).toHaveText('The settings service could not save this change.');
  await expect(dialog.getByLabel('Safety buffer (seconds)')).toHaveValue('123');
  brain.failSettings = false;
  await dialog.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect.poll(() => brain.settings.creditRecovery.safetyBufferSeconds).toBe(123);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('an older rejected autosave cannot mark the newer draft as failed', async ({ page }) => {
  const brain = await mockBrain(page);
  let release!: () => void;
  let held = false;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT' && route.request().postDataJSON()?.creditRecovery?.safetyBufferSeconds === 121) {
      held = true;
      await ready;
      return route.fulfill({ status: 503, json: { error: 'Rejected old draft' } });
    }
    return route.fallback();
  });
  await page.goto('/');
  const dialog = await openSettings(page, 'Recovery');
  await dialog.getByLabel('Safety buffer (seconds)').fill('121');
  await expect.poll(() => held).toBe(true);
  // Freeze the new draft's debounce while the older network request settles.
  await page.clock.install();
  await dialog.getByLabel('Safety buffer (seconds)').fill('122');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.status() === 503);
  release();
  await completed;
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByLabel('Safety buffer (seconds)')).toHaveValue('122');
  await page.clock.runFor(800);
  await expect.poll(() => brain.settings.creditRecovery.safetyBufferSeconds).toBe(122);
});

test('stage model drafts survive category navigation and need an explicit discard', async ({ page }) => {
  const settings = defaultTestSettings();
  const brain = await mockBrain(page, { settings, modelOptions: {
    stages: [{ id: 'first-pass', label: 'First pass', description: 'Develop expert perspectives.' }],
    models: [{ id: 'auto', label: 'Default model' }, { id: 'fast', label: 'Fast model' }],
  } });
  await page.goto('/');
  const dialog = await openSettings(page, 'Stage models');
  await dialog.getByRole('combobox', { name: 'First pass model', exact: true }).selectOption('fast');
  for (const category of ['Models & connections', 'Appearance', 'Research']) {
    await dialog.getByRole('button', { name: category, exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'First pass model', exact: true })).not.toBeVisible();
    await dialog.getByRole('button', { name: 'Stage models', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'First pass model', exact: true })).toHaveValue('fast');
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog.getByText('You have stage model choices that have not been saved. Keep editing to save them, or discard the draft.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']?.['first-pass']?.model).toBe('fast');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('a provider change preserves the previous provider stage draft and close warning', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm.apiKeyConfigured = true;
  const brain = await mockBrain(page, { settings, modelOptions: {
    stages: [{ id: 'first-pass', label: 'First pass', description: 'Develop expert perspectives.' }],
    models: [{ id: 'auto', label: 'Default model' }, { id: 'fast', label: 'Fast model' }],
  } });
  await page.goto('/');
  const dialog = await openSettings(page, 'Stage models');
  await dialog.getByRole('combobox', { name: 'First pass model', exact: true }).selectOption('fast');
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await dialog.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await expect.poll(() => brain.settings.llm.provider).toBe('anthropic');
  await dialog.getByRole('button', { name: 'Stage models', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'First pass model', exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog.getByText('You have stage model choices that have not been saved. Keep editing to save them, or discard the draft.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await dialog.getByLabel('Provider', { exact: true }).selectOption('cursor-agent');
  await expect.poll(() => brain.settings.llm.provider).toBe('cursor-agent');
  await dialog.getByRole('button', { name: 'Stage models', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'First pass model', exact: true })).toHaveValue('fast');
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']?.['first-pass']?.model).toBe('fast');
});
