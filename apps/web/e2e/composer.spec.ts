import { test, expect, type Page } from '@playwright/test';
import { defaultTestSettings, makeJob, mockBrain } from './fixtures';

const question = (page: Page) => page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });

async function mockComposer(page: Page, options?: Parameters<typeof mockBrain>[1]) {
  const brain = await mockBrain(page, options);
  await page.route('**/api/availability', route => route.fulfill({
    json: { version: 1, updatedAt: Date.now(), tools: [], purposes: [], demoteDegraded: false },
  }));
  return brain;
}

async function openSettings(page: Page, category: 'Tools & sources' | 'Models & connections') {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: category, exact: true }).click();
  return dialog;
}


async function attachReference(page: Page, url = 'https://example.test/reference.pdf') {
  await page.getByRole('button', { name: 'Attach from server', exact: true }).click();
  await page.getByRole('menuitem', { name: /Web URL/ }).click();
  await page.getByRole('textbox', { name: 'web URL attachment', exact: true }).fill(url);
  await page.getByRole('button', { name: 'Check & attach', exact: true }).click();
  await expect(page.getByRole('button', { name: '1 attachment — review or remove', exact: true })).toBeVisible();
}

async function expectNoOverflow(page: Page) {
  const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, overflowing: [...document.querySelectorAll('body *')].filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((node) => ({ element: node.tagName, class: node.className, right: node.getBoundingClientRect().right })) }));
  expect(size.content, JSON.stringify(size.overflowing)).toBeLessThanOrEqual(size.viewport + 1);
}

test('draft and validated attachment survive history and job navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const brain = await mockComposer(page);
  await page.goto('/');
  const draft = 'Keep this working draft while I inspect earlier research.\nThis second line matters too.';
  await question(page).fill(draft);
  await attachReference(page);
  await page.goto('/#/history');
  await expect(page.locator('.library-content[data-section="history"] .library-row')).toHaveCount(2);
  await page.locator('.library-content[data-section="history"] a[href="#/jobs/test-run-1"]').click();
  await expect(page).toHaveURL(/#\/jobs\/test-run-1/);
  await expect(page.locator('.dash')).toBeVisible();
  await expect(page.locator('.canvas-view-error')).toHaveCount(0);
  await expect(page.locator('.canvas-home')).toBeHidden();
  await page.getByRole('link', { name: 'New research', exact: true }).click();
  await expect(question(page)).toHaveValue(draft);
  await page.getByRole('button', { name: '1 attachment — review or remove', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'attachments for the next run' })).toContainText('reference.pdf');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('Settings capability choices survive navigation and are sent with the draft and validated paths', async ({ page }) => {
  const brain = await mockComposer(page);
  await page.goto('/');
  await question(page).fill('Evaluate scientific review reliability.');
  await attachReference(page);
  const settings = await openSettings(page, 'Tools & sources');
  await settings.getByRole('switch', { name: 'Web Search', exact: true }).click();
  await expect(settings.getByRole('switch', { name: 'Web Search', exact: true })).not.toBeChecked();
  await expect(settings.getByRole('switch', { name: 'Taxonomy Access (always on)', exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('#sidebar-history-trigger').click();
  await page.getByRole('link', { name: 'Open research: Research record 1', exact: true }).click();
  await expect(page.locator('.dash')).toBeVisible();
  await page.getByRole('link', { name: 'New research', exact: true }).click();
  await openSettings(page, 'Tools & sources');
  await expect(settings.getByRole('switch', { name: 'Web Search', exact: true })).not.toBeChecked();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(question(page)).toHaveValue('Evaluate scientific review reliability.');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page).toHaveURL(/#\/jobs\/test-submitted-run/);
  await expect(page.locator('.dash')).toBeVisible();
  await expect(page.locator('.canvas-view-error')).toHaveCount(0);
  const write = brain.writes.find((entry) => entry.method === 'POST' && entry.path === '/jobs');
  expect(write?.body).toEqual({ topic: 'Evaluate scientific review reliability.', attachments: ['https://example.test/reference.pdf'], capabilityOverrides: { 'web-search': false } });
  await page.getByRole('link', { name: 'New research', exact: true }).click();
  await expect(question(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: '1 attachment — review or remove', exact: true })).toHaveCount(0);
});

test('a validation failure keeps the prompt and reference for an explicit retry', async ({ page }) => {
  const brain = await mockComposer(page);
  await page.goto('/');
  await question(page).fill('Retain this draft if the attachment host fails.');
  await attachReference(page);
  brain.failValidation = true;
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.locator('.attach-error')).toContainText('The attachment server could not be reached.');
  await expect(question(page)).toHaveValue('Retain this draft if the attachment host fails.');
  expect(brain.writes.filter((entry) => entry.path === '/jobs')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'send', exact: true })).toBeEnabled();
});

test('readiness holds a submission and launches it once after the environment recovers', async ({ page }) => {
  const brain = await mockComposer(page);
  brain.readiness = { ready: false, updatedAt: Date.now(), checks: [{ id: 'llm', label: 'Model connection', required: true, state: 'failed', message: 'Waiting for a connection' }] };
  await page.goto('/');
  await question(page).fill('Launch this question only when the environment is ready.');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('Preparing the environment', { exact: true })).toBeVisible();
  await expect(question(page)).toBeDisabled();
  expect(brain.writes.filter((entry) => entry.path === '/jobs')).toHaveLength(0);
  // A reconnecting overview stream also reads this fixture. Change readiness
  // only when the check is requested so SSE cannot remove the button mid-click.
  await page.route('**/api/readiness/check', async route => {
    brain.readiness = { ready: true, updatedAt: Date.now(), checks: [{ id: 'llm', label: 'Model connection', required: true, state: 'ok', message: 'Ready' }] };
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Run checks again', exact: true }).click();
  await expect(page).toHaveURL(/#\/jobs\/test-submitted-run/);
  expect(brain.writes.filter((entry) => entry.path === '/jobs')).toHaveLength(1);
});

test('a failed primary search provider does not block submission when the server confirms a scholarly fallback', async ({ page }) => {
  const brain = await mockComposer(page);
  brain.readiness = { ready: true, updatedAt: Date.now(), checks: [
    { id: 'llm', label: 'Model connection', required: true, state: 'ok', message: 'Connected' },
    { id: 'capabilities', label: 'Agent capabilities', required: true, state: 'ok', message: 'SearXNG unavailable; scholarly search remains available.', detail: 'General web search is unavailable. OpenAlex, Crossref and arXiv remain available for research.' },
  ] };
  await page.goto('/');
  const draft = 'Compare published approaches using the available scholarly sources.';
  await question(page).fill(draft);
  const settings = await openSettings(page, 'Tools & sources');
  const check = settings.getByRole('article', { name: 'Agent capabilities check', exact: true });
  await expect(check.getByRole('status')).toHaveText('Ready');
  await expect(check).toContainText('SearXNG unavailable; scholarly search remains available.');
  await check.getByText('Technical details', { exact: true }).click();
  await expect(check).toContainText('General web search is unavailable.');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page).toHaveURL(/#\/jobs\/test-submitted-run/);
  await expect(page.getByText('Preparing the environment', { exact: true })).toHaveCount(0);
  const submissions = brain.writes.filter(write => write.path === '/jobs');
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.body.topic).toBe(draft);
  expect(brain.writes.filter(write => write.path === '/readiness/check')).toHaveLength(0);
  expect(brain.unhandled).toEqual([]);
});

test('when the server reports no available search route the composer holds the submission and preserves its draft', async ({ page }) => {
  const brain = await mockComposer(page);
  brain.readiness = { ready: false, updatedAt: Date.now(), checks: [
    { id: 'llm', label: 'Model connection', required: true, state: 'ok', message: 'Connected' },
    { id: 'capabilities', label: 'Agent capabilities', required: true, state: 'failed', message: 'SearXNG is unavailable and no alternative search route is configured.' },
  ] };
  await page.goto('/');
  const draft = 'Keep this research question until a configured search route is available.';
  await question(page).fill(draft);
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('Preparing the environment', { exact: true })).toBeVisible();
  await expect(page.getByText('SearXNG is unavailable and no alternative search route is configured.', { exact: true })).toBeVisible();
  await expect(question(page)).toHaveValue(draft);
  await expect(question(page)).toBeDisabled();
  expect(brain.writes.filter(write => write.path === '/jobs')).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question(page)).toBeEnabled();
  await expect(question(page)).toHaveValue(draft);
  expect(brain.writes.filter(write => write.path === '/jobs')).toHaveLength(0);
  expect(brain.unhandled).toEqual([]);
});

test('the composer stays minimal while Settings retains tool diagnostics and the model connection stays accessible', async ({ page }) => {
  const brain = await mockComposer(page);
  brain.readiness = { ready: false, updatedAt: Date.now(), checks: [
    { id: 'llm', label: 'Model connection', required: true, state: 'ok', message: 'Connected' },
    { id: 'capabilities', label: 'Agent capabilities', required: true, state: 'failed', message: 'Capability host unavailable', detail: 'The host tool service could not be reached.' },
    { id: 'code', label: 'Code execution', required: true, state: 'failed', message: 'Execution workspace unavailable', detail: 'The workspace path is not writable.' },
    { id: 'internet', label: 'Internet access', required: true, state: 'failed', message: 'Search connection unavailable', detail: 'The search provider request timed out.' },
  ] };
  await page.goto('/');
  await question(page).fill('Keep this draft while inspecting tool checks.');
  await expect(page.getByRole('button', { name: /^Capabilities:/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Models by task type:/ })).toHaveCount(0);
  const status = page.locator('.canvas-composer-health');
  await expect(status.getByRole('button', { name: /^(Agent capabilities|Code execution|Internet access|Tools and providers)/ })).toHaveCount(0);
  await status.getByRole('button', { name: /^Model connection:/ }).click();
  const modelCheck = page.getByRole('dialog', { name: 'Model connection check', exact: true });
  await expect(modelCheck).toContainText('Connected');
  await page.keyboard.press('Escape');
  await expect(modelCheck).not.toBeVisible();

  const settings = await openSettings(page, 'Tools & sources');
  const capabilities = settings.getByRole('article', { name: 'Agent capabilities check', exact: true });
  const code = settings.getByRole('article', { name: 'Code execution check', exact: true });
  const internet = settings.getByRole('article', { name: 'Internet access check', exact: true });
  for (const check of [capabilities, code, internet]) await check.getByText('Technical details', { exact: true }).click();
  await expect(capabilities.getByText('The host tool service could not be reached.', { exact: true })).toBeVisible();
  await expect(code.getByText('The workspace path is not writable.', { exact: true })).toBeVisible();
  await expect(internet.getByText('The search provider request timed out.', { exact: true })).toBeVisible();

  brain.readiness = { ...brain.readiness, checks: brain.readiness.checks.map(check => check.id === 'capabilities' ? { ...check, state: 'ok', message: 'Capabilities checked again', detail: 'The tool service is ready.' } : check) };
  await capabilities.getByRole('button', { name: 'Re-run check', exact: true }).click();
  await expect.poll(() => brain.writes.find(entry => entry.path === '/readiness/check')?.body).toEqual({ checks: ['capabilities'] });
  await expect(capabilities).toContainText('Capabilities checked again');
  await expect(capabilities.getByRole('button', { name: 'Ask AI for help', exact: true })).toHaveCount(0);

  brain.readiness = { ...brain.readiness, checks: brain.readiness.checks.map(check => check.id === 'code' ? { ...check, advice: 'Choose a writable workspace directory.' } : check) };
  await code.getByRole('button', { name: 'Ask AI for help', exact: true }).click();
  await expect.poll(() => brain.writes.find(entry => entry.path === '/readiness/diagnose')?.body).toEqual({ check: 'code' });
  await expect(code).toContainText('Choose a writable workspace directory.');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(question(page)).toHaveValue('Keep this draft while inspecting tool checks.');
  await page.locator('#sidebar-history-trigger').click();
  await page.getByRole('link', { name: 'Open research: Research record 1', exact: true }).click();
  await expect(page.locator('.dash')).toBeVisible();
  await openSettings(page, 'Tools & sources');
  await expect(internet).toContainText('Search connection unavailable');
  brain.readiness = { ...brain.readiness, checks: brain.readiness.checks.map(check => check.id === 'internet' ? { ...check, state: 'ok', message: 'Connection checked from the research view' } : check) };
  await internet.getByRole('button', { name: 'Re-run check', exact: true }).click();
  await expect.poll(() => brain.writes.filter(entry => entry.path === '/readiness/check').at(-1)?.body).toEqual({ checks: ['internet'] });
  await expect(internet).toContainText('Connection checked from the research view');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  expect(brain.writes.filter(entry => entry.path === '/jobs')).toHaveLength(0);
  expect(brain.unhandled).toEqual([]);
});

test('ten thousand history records stay bounded and searchable without bulk detail fetches', async ({ page }) => {
  const brain = await mockComposer(page, { jobs: Array.from({ length: 10_000 }, (_, index) => makeJob(index)) });
  await page.goto('/#/history');
  await expect(page.locator('.library-content[data-section="history"] .library-row')).toHaveCount(50);
  expect(brain.requests.filter((request) => /^\/jobs\/[^/]+$/.test(request.path))).toHaveLength(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'History pages' })).toContainText('51–100 of 10,000');
  await page.getByRole('textbox', { name: 'Search research history', exact: true }).fill('Research record 9999');
  await expect(page.locator('.library-content[data-section="history"] .library-row')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Open research: Research record 9999', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open research: Research record 9999', exact: true }).click();
  await expect(page.locator('.dash')).toBeVisible();
  await expect.poll(() => brain.requests.filter((request) => /^\/jobs\/[^/]+$/.test(request.path)).length).toBe(1);
});

test('attachment menus restore focus and Settings task-model saves preserve unrelated routes and the draft', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { ...settings.llm, modelsByRoute: { synthesis: 'retained-custom-model', embedding: 'embedding-special' } };
  const brain = await mockComposer(page, { settings });
  await page.goto('/');
  await question(page).fill('A draft that stays while models are configured');
  const attachments = page.getByRole('button', { name: 'Attach from server', exact: true });
  await attachments.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: /Files Browse server files/ })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(attachments).toBeFocused();
  const models = await openSettings(page, 'Models & connections');
  await models.getByRole('combobox', { name: 'Review', exact: true }).selectOption('review-model');
  await expect(models.getByRole('combobox', { name: 'Synthesis', exact: true })).toHaveValue('retained-custom-model');
  await models.getByRole('button', { name: 'Save models', exact: true }).click();
  const expected = { review: 'review-model', synthesis: 'retained-custom-model', embedding: 'embedding-special' };
  await expect.poll(() => brain.writes.find((entry) => entry.path === '/settings/models-by-route')?.body).toEqual({ modelsByRoute: expected });
  await expect(models.getByText('Models saved', { exact: true })).toBeVisible();
  await models.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(models).not.toBeVisible();
  await expect(page.locator('#canvas-settings-trigger')).toBeFocused();
  await expect(question(page)).toHaveValue('A draft that stays while models are configured');
  await openSettings(page, 'Models & connections');
  await expect(models.getByRole('combobox', { name: 'Review', exact: true })).toHaveValue('review-model');
  await expect(models.getByRole('combobox', { name: 'Synthesis', exact: true })).toHaveValue('retained-custom-model');
  await models.getByRole('button', { name: 'Done', exact: true }).click();
});

test('viewport resizing reflows an unchanged draft and preserves selection and scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const brain = await mockComposer(page);
  await page.goto('/');
  const prompt = question(page);
  const draft = 'A scientific question about agent reliability, evidence quality, review independence, and reproducibility.';
  await prompt.fill(draft);
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(8, 31));
  const initial = await prompt.evaluate((element: HTMLTextAreaElement) => ({ width: element.clientWidth, height: element.clientHeight }));
  await page.setViewportSize({ width: 560, height: 1000 });
  await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => element.clientWidth)).toBeLessThan(initial.width);
  await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => element.clientHeight)).toBeGreaterThan(initial.height);
  expect(await prompt.evaluate((element: HTMLTextAreaElement) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await expect(prompt).toHaveValue(draft);
  expect(await prompt.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([8, 31]);
  await expect(prompt).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => element.clientHeight)).toBe(initial.height);

  const longDraft = Array.from({ length: 50 }, (_, index) => `Line ${index + 1}: Preserve the current reading position while the workspace changes width.`).join('\n');
  await prompt.fill(longDraft);
  await prompt.evaluate((element: HTMLTextAreaElement) => { element.setSelectionRange(10, 30); element.scrollTop = 120; });
  await page.setViewportSize({ width: 560, height: 1000 });
  await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => element.clientWidth)).toBeLessThan(initial.width);
  await expect.poll(() => prompt.evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBe(120);
  expect(await prompt.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([10, 30]);
  await expect(prompt).toHaveValue(longDraft);
  await expect(prompt).toBeFocused();
  expect(brain.unhandled).toEqual([]);
});

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1080, height: 1920 }, { width: 3440, height: 1440 }]) {
  test(`home, composer controls and history fit ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockComposer(page);
    await page.goto('/');
    await question(page).fill('A deliberately longer prompt that remains editable in portrait and landscape, without covering its controls.');
    await expectNoOverflow(page);
    await page.getByRole('button', { name: 'Attach from server', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Attach from server', exact: true });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    await page.keyboard.press('Escape');
    const models = await openSettings(page, 'Models & connections');
    await expect(models.getByRole('combobox', { name: 'Review', exact: true })).toBeVisible();
    const panelBounds = await models.boundingBox();
    expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    await models.getByRole('button', { name: 'Done', exact: true }).click();
    await page.goto('/#/history');
    await expect(page.locator('.library-content[data-section="history"] .library-row')).toHaveCount(2);
    await expectNoOverflow(page);
  });
}
