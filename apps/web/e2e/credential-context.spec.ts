import { expect, test, type Page } from '@playwright/test';
import { defaultTestSettings, mockBrain } from './fixtures';

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

test('an unconfigured provider stays a draft and wrapped Claude tokens normalize only on Save', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.getByLabel('Provider', { exact: true }).selectOption('claude-agent');
  await expect(settings.getByText(/^Active provider: Cursor SDK/)).toBeVisible();
  expect(brain.writes.filter(write => write.path === '/settings')).toHaveLength(0);
  await settings.getByLabel('Setup token', { exact: true }).fill('  sk-ant-oat01-browser\u00a0-\nwrapped\t-token  ');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;
  expect(brain.writes.find(write => write.path === '/settings')?.body.llm).toMatchObject({ provider: 'claude-agent', setupToken: 'sk-ant-oat01-browser-wrapped-token' });
  await expect(settings.getByText(/^Claude Agent SDK token verified/)).toBeVisible();
  await expect(settings.getByText(/^Active provider:/)).toHaveCount(0);
});

test('credential verification replaces old model errors and a new draft clears its prior rejection', async ({ page }) => {
  const initial = defaultTestSettings(); initial.llm = { ...initial.llm, setupTokenConfigured: true };
  await mockBrain(page, { settings: initial });
  let rejectToken = true;
  await page.route('**/api/settings', async route => {
    const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : undefined;
    if (body?.llm?.provider === 'claude-agent') {
      if (!body.llm.setupToken) return route.fulfill({ status: 503, json: { error: 'Stored connection verification timed out.' } });
      if (rejectToken) return route.fulfill({ status: 401, json: { error: 'Replacement token was rejected.' } });
    }
    return route.fallback();
  });
  await page.goto('/'); const settings = await openSettings(page);
  await settings.getByLabel('Provider', { exact: true }).selectOption('claude-agent');
  await expect(settings.getByRole('alert')).toContainText('Stored connection verification timed out.');
  await settings.getByLabel('Setup token', { exact: true }).fill('browser-test-token-one');
  await expect(settings.getByText('Stored connection verification timed out.', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveText('Replacement token was rejected.');
  await settings.getByLabel('Setup token', { exact: true }).fill('browser-test-token-two');
  await expect(settings.getByRole('alert')).toHaveCount(0);
  rejectToken = false;
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings.getByText(/^Claude Agent SDK token verified/)).toBeVisible();
  await expect(settings.getByRole('alert')).toHaveCount(0);
});

test('a pending credential rejection cannot attach to another selected provider', async ({ page }) => {
  const initial = defaultTestSettings(); initial.llm = { ...initial.llm, setupTokenConfigured: true };
  const brain = await mockBrain(page, { settings: initial });
  let release: (() => void) | undefined;
  await page.route('**/api/settings', async route => {
    const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : undefined;
    if (body?.llm?.setupToken) {
      await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ status: 401, json: { error: 'Old Claude token rejected.' } });
    }
    return route.fallback();
  });
  await page.goto('/'); const settings = await openSettings(page);
  await settings.getByLabel('Provider', { exact: true }).selectOption('claude-agent');
  await settings.getByLabel('Setup token', { exact: true }).fill('browser-test-pending-token');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await settings.getByLabel('Provider', { exact: true }).selectOption('cursor-agent');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT' && response.request().postDataJSON()?.llm?.provider === 'cursor-agent');
  release!();
  await completed;
  await expect(settings.getByRole('alert')).toHaveCount(0);
  await expect(settings.getByLabel('Provider', { exact: true })).toHaveValue('cursor-agent');
  expect(brain.settings.llm.provider).toBe('cursor-agent');
  // A replacement draft is not an instruction to verify the stored token.
  const writesBefore = brain.writes.length;
  await settings.getByLabel('Provider', { exact: true }).selectOption('claude-agent');
  await expect(settings.getByLabel('Setup token', { exact: true })).toHaveValue('browser-test-pending-token');
  expect(brain.writes).toHaveLength(writesBefore);
});

test('onboarding keeps provider drafts separate and ignores obsolete verification errors', async ({ page }) => {
  const initial = defaultTestSettings(); initial.llm = { provider: 'claude-agent', setupTokenConfigured: false };
  await mockBrain(page, { settings: initial });
  let release: (() => void) | undefined;
  let attempts = 0;
  await page.route('**/api/settings', async route => {
    const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : undefined;
    if (body?.llm?.setupToken) {
      attempts += 1;
      await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ status: 401, json: { error: 'Old onboarding token rejected.' } });
    }
    return route.fallback();
  });
  await page.goto('/');
  const onboarding = page.getByRole('dialog', { name: 'Connect a model', exact: true });
  const token = onboarding.getByLabel('Setup token', { exact: true });
  await token.fill('browser-test-claude-draft');
  await token.press('Enter');
  await expect.poll(() => Boolean(release)).toBe(true);
  await token.press('Enter');
  await onboarding.getByRole('radio', { name: /Cursor API key/ }).click();
  const key = onboarding.getByLabel('API key', { exact: true });
  await expect(key).toHaveValue('');
  await key.fill('browser-test-cursor-draft');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.status() === 401);
  release!(); await completed;
  await expect(onboarding.locator('.onboard-error')).toHaveCount(0);
  await expect(key).toHaveValue('browser-test-cursor-draft');
  await onboarding.getByRole('radio', { name: /Claude setup token/ }).click();
  await expect(token).toHaveValue('browser-test-claude-draft');
  expect(attempts).toBe(1);
});

test('onboarding normalizes wrapped setup tokens before its explicit connection request', async ({ page }) => {
  const initial = defaultTestSettings(); initial.llm = { provider: 'claude-agent', setupTokenConfigured: false };
  const brain = await mockBrain(page, { settings: initial });
  await page.goto('/');
  const onboarding = page.getByRole('dialog', { name: 'Connect a model', exact: true });
  await onboarding.getByLabel('Setup token', { exact: true }).fill(' sk-ant-oat01-browser\u00a0-token\t-part ');
  await onboarding.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => brain.writes.find(write => write.path === '/settings')?.body.llm.setupToken).toBe('sk-ant-oat01-browser-token-part');
  await expect(onboarding).toHaveCount(0);
});
