import { expect, test, type Page } from '@playwright/test';
import type { ModelOptionsResponse, StageOption } from '@brainstorm-agentic/protocol';
import { defaultTestSettings, mockBrain } from './fixtures';

const stages: StageOption[] = [
  { id: 'classify-input', label: 'Classify input', description: 'Identify the research question and its requirements.', route: 'balanced' },
  { id: 'first-pass', label: 'First pass', description: 'Develop independent expert perspectives.', route: 'reasoning' },
  { id: 'synthesis', label: 'Synthesis', description: 'Combine the reviewed perspectives.', route: 'writing' },
];
const modelOptions: Partial<ModelOptionsResponse> = {
  stages,
  models: [
    { id: 'auto', label: 'Claude Sonnet', capabilities: { effortLevels: ['low', 'medium', 'high'], adaptiveThinking: true, thinkingCanBeDisabled: true } },
    { id: 'opus', label: 'Claude Opus', capabilities: { effortLevels: ['low', 'medium', 'high', 'max'], adaptiveThinking: true } },
    { id: 'fast', label: 'Fast model', capabilities: { effortLevels: ['low'], adaptiveThinking: false } },
    { id: 'custom', label: 'Custom model' },
  ],
};
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Pipeline models', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Pipeline models', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(dialog.getByRole('button', { name: 'Models & connections', exact: true })).not.toHaveAttribute('aria-current', 'page');
  await expect(dialog.getByRole('heading', { name: 'Models by pipeline stage', exact: true })).toBeVisible();
  return dialog;
}
const requests = (brain: Awaited<ReturnType<typeof mockBrain>>) => brain.requests.filter(request => request.path === '/model-options').length;

test('pipeline choices are independent by stage and persist after reload and provider changes', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { ...settings.llm, apiKeyConfigured: true,
    stageSettingsByProvider: { anthropic: { 'classify-input': { model: 'opus', effort: 'max', thinking: 'adaptive' } } } };
  const brain = await mockBrain(page, { settings, modelOptions });
  await page.goto('/');
  let dialog = await openSettings(page);
  await dialog.getByRole('combobox', { name: 'Classify input model', exact: true }).selectOption('auto');
  await dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true }).selectOption('disabled');
  await dialog.getByRole('combobox', { name: 'Classify input reasoning effort', exact: true }).selectOption('low');
  await dialog.getByRole('combobox', { name: 'Classify input thinking transcript', exact: true }).selectOption('if-available');
  await dialog.getByRole('combobox', { name: 'First pass model', exact: true }).selectOption('opus');
  await dialog.getByRole('combobox', { name: 'First pass thinking mode', exact: true }).selectOption('adaptive');
  await dialog.getByRole('combobox', { name: 'First pass reasoning effort', exact: true }).selectOption('max');
  await dialog.getByRole('combobox', { name: 'First pass thinking transcript', exact: true }).selectOption('off');
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  const expected = {
    'classify-input': { model: 'auto', thinking: 'disabled', effort: 'low', transcript: 'if-available' },
    'first-pass': { model: 'opus', thinking: 'adaptive', effort: 'max', transcript: 'off' },
  };
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']).toEqual(expected);
  expect(brain.settings.llm.agentSdk).toEqual({ maxTurns: 80, effort: 'high', thinking: 'adaptive' });
  await page.reload();
  dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true })).toHaveValue('disabled');
  await expect(dialog.getByRole('combobox', { name: 'First pass thinking mode', exact: true })).toHaveValue('adaptive');
  await expect(dialog.getByRole('combobox', { name: 'First pass reasoning effort', exact: true })).toHaveValue('max');
  await expect(dialog.getByRole('combobox', { name: 'First pass thinking transcript', exact: true })).toHaveValue('off');
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('anthropic');
  await expect.poll(() => brain.settings.llm.provider).toBe('anthropic');
  await dialog.getByRole('button', { name: 'Pipeline models', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Classify input model', exact: true })).toHaveValue('opus');
  await expect(dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true })).toHaveValue('adaptive');
  await expect(dialog.getByRole('combobox', { name: 'First pass model', exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('cursor-agent');
  await expect.poll(() => brain.settings.llm.provider).toBe('cursor-agent');
  await dialog.getByRole('button', { name: 'Pipeline models', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true })).toHaveValue('disabled');
  await expect(dialog.getByRole('combobox', { name: 'First pass reasoning effort', exact: true })).toHaveValue('max');
  expect(brain.settings.llm.stageSettingsByProvider?.['cursor-agent']).toEqual(expected);
  expect(brain.unhandled).toEqual([]);
});

test('a model that requires thinking does not offer disabled mode', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm.agentSdk = { ...settings.llm.agentSdk!, thinking: 'disabled' };
  await mockBrain(page, { settings, modelOptions: { ...modelOptions, models: [
    { id: 'auto', label: 'Required thinking', capabilities: { effortLevels: ['high'], adaptiveThinking: true, thinkingCanBeDisabled: false } },
  ] } });
  await page.goto('/');
  const dialog = await openSettings(page);
  const thinking = dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true });
  await expect(thinking.locator('option')).toHaveText(['Default (adaptive, required by model)', 'Adaptive']);
  await expect(dialog.getByText('This model requires adaptive thinking.')).toHaveCount(stages.length);
  await expect(dialog.getByRole('combobox', { name: 'Classify input thinking transcript', exact: true })).toBeEnabled();
});

test('Gemini reasoning and transcript controls are independent, including unknown models', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { provider: 'gemini', model: 'gemini-3.5-flash-lite', geminiApiKeyConfigured: true, transcript: 'off' };
  const brain = await mockBrain(page, { settings, modelOptions: { stages, models: [
    { id: 'gemini-3.5-flash-lite', label: 'Gemini Flash-Lite', capabilities: { effortLevels: ['minimal', 'low', 'medium', 'high'], adaptiveThinking: false } },
    { id: 'unknown', label: 'Unknown model' },
  ] } });
  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true })).toBeDisabled();
  const effort = dialog.getByRole('combobox', { name: 'Classify input reasoning effort', exact: true });
  await expect(effort.locator('option')).toHaveText(['Default (model decides)', 'Minimal', 'Low', 'Medium', 'High']);
  await effort.selectOption('minimal');
  const transcript = dialog.getByRole('combobox', { name: 'Classify input thinking transcript', exact: true });
  await expect(transcript.locator('option').first()).toHaveText('Default (off)');
  await transcript.selectOption('off');
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.gemini?.['classify-input']).toEqual({ effort: 'minimal', transcript: 'off' });
  await dialog.getByRole('combobox', { name: 'Classify input model', exact: true }).selectOption('unknown');
  await expect(effort).toBeDisabled();
  await expect(transcript).toBeEnabled();
  await expect(transcript).toHaveValue('off');
  expect(brain.unhandled).toEqual([]);
});

test('changing transcript recording updates stage defaults without changing reasoning or credentials', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { provider: 'gemini', model: 'gemini-3.5-flash-lite', geminiApiKeyConfigured: true,
    transcript: 'if-available', stageSettingsByProvider: { gemini: { 'classify-input': { effort: 'minimal', transcript: 'if-available' } } } };
  const brain = await mockBrain(page, { settings, modelOptions: { stages, models: [
    { id: 'gemini-3.5-flash-lite', label: 'Gemini Flash-Lite', capabilities: { effortLevels: ['minimal', 'low', 'medium', 'high'], adaptiveThinking: false } },
  ] } });
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await dialog.getByRole('switch', { name: 'Record thinking transcripts when available', exact: true }).click();
  await expect.poll(() => brain.settings.llm.transcript).toBe('off');
  await dialog.getByRole('button', { name: 'Pipeline models', exact: true }).click();
  const transcript = dialog.getByRole('combobox', { name: 'Classify input thinking transcript', exact: true });
  await expect(transcript.locator('option').first()).toHaveText('Default (off)');
  await expect(transcript).toHaveValue('if-available');
  await expect(dialog.getByRole('combobox', { name: 'Classify input reasoning effort', exact: true })).toHaveValue('minimal');
  const write = brain.writes.find(entry => entry.path === '/settings');
  expect(write?.body.llm).toEqual({ provider: 'gemini', transcript: 'off' });
  expect(brain.unhandled).toEqual([]);
});

test('launch loads one shared catalog and stage controls follow selected model capabilities', async ({ page }) => {
  const brain = await mockBrain(page, { modelOptions });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open settings menu', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => requests(brain)).toBe(1);
  const dialog = await openSettings(page);
  const model = dialog.getByRole('combobox', { name: 'Classify input model', exact: true });
  const effort = dialog.getByRole('combobox', { name: 'Classify input reasoning effort', exact: true });
  const thinking = dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true });
  await expect(effort.locator('option')).toHaveText(['Default (high)', 'Low', 'Medium', 'High']);
  await expect(thinking).toBeEnabled();
  await model.selectOption('opus');
  await expect(effort.locator('option')).toHaveText(['Default (high)', 'Low', 'Medium', 'High', 'Max']);
  await expect(thinking.locator('option')).toHaveText(['Default (adaptive)', 'Adaptive']);
  await expect(thinking).toBeEnabled();
  await model.selectOption('fast');
  await expect(effort.locator('option')).toHaveText(['Default (model decides)', 'Low']);
  await expect(thinking).toBeDisabled();
  await expect(thinking.locator('option')).toHaveText(['Default (model controlled)']);
  await model.selectOption('custom');
  await expect(effort).toBeDisabled();
  await expect(dialog.getByText('Reasoning controls are unavailable until this model’s capabilities are known.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await openSettings(page);
  await model.focus();
  await page.keyboard.press('ArrowDown');
  expect(requests(brain)).toBe(1);
  expect(brain.unhandled).toEqual([]);
});

test('stage saves preserve hidden choices, clear incompatible reasoning, and reset only one stage', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { ...settings.llm, stageSettingsByProvider: { 'cursor-agent': { hidden: { model: 'retained-model' }, synthesis: { model: 'unlisted-model' } }, 'claude-agent': { 'first-pass': { model: 'opus' } } } };
  const brain = await mockBrain(page, { settings, modelOptions });
  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: 'Synthesis model', exact: true })).toHaveValue('unlisted-model');
  const model = dialog.getByRole('combobox', { name: 'Classify input model', exact: true });
  const effort = dialog.getByRole('combobox', { name: 'Classify input reasoning effort', exact: true });
  await effort.selectOption('high');
  await dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true }).selectOption('disabled');
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect(dialog.getByText('Models saved', { exact: true })).toBeVisible();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']?.['classify-input']).toEqual({ effort: 'high', thinking: 'disabled' });
  await model.selectOption('fast');
  await expect(effort).toHaveValue('');
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']).toEqual({ hidden: { model: 'retained-model' }, synthesis: { model: 'unlisted-model' }, 'classify-input': { model: 'fast' } });
  await dialog.getByRole('button', { name: 'Reset Classify input to defaults', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']).toEqual({ hidden: { model: 'retained-model' }, synthesis: { model: 'unlisted-model' } });
  expect(brain.settings.llm.stageSettingsByProvider?.['claude-agent']).toEqual({ 'first-pass': { model: 'opus' } });
  expect(brain.writes.filter(write => write.path === '/settings/stage-models').every(write => write.body.provider === 'cursor-agent')).toBe(true);
});

test('failed saves retain the draft and provider changes load that provider’s saved stages', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { ...settings.llm, apiKeyConfigured: true, stageSettingsByProvider: { anthropic: { 'classify-input': { model: 'opus', effort: 'max' } } } };
  const brain = await mockBrain(page, { settings, modelOptions });
  await page.goto('/');
  const dialog = await openSettings(page);
  const model = dialog.getByRole('combobox', { name: 'Classify input model', exact: true });
  await model.selectOption('fast');
  brain.failSettings = 'Try saving again';
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Try saving again');
  await expect(model).toHaveValue('fast');
  brain.failSettings = false;
  await dialog.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(model).toHaveValue('');
  await dialog.getByRole('button', { name: 'Models & connections', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('anthropic');
  await expect.poll(() => brain.settings.llm.provider).toBe('anthropic');
  await dialog.getByRole('button', { name: 'Pipeline models', exact: true }).click();
  await expect(model).toHaveValue('opus');
  await expect(dialog.getByRole('combobox', { name: 'Classify input reasoning effort', exact: true })).toHaveValue('max');
  expect(requests(brain)).toBe(2);
});

test('a rejected research launch refreshes stored model information without opening settings', async ({ page }) => {
  const brain = await mockBrain(page, { modelOptions });
  await page.route('**/api/jobs', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 409, json: { error: 'The selected model is no longer available.' } });
    await route.fallback();
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open settings menu', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => requests(brain)).toBe(1);
  await page.getByRole('textbox', { name: 'What do you want to think through?', exact: true }).fill('A research question');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('The selected model is no longer available.', { exact: true })).toBeVisible();
  await expect.poll(() => requests(brain)).toBe(2);
  await openSettings(page);
  expect(requests(brain)).toBe(2);
});

test('unknown off support never claims thinking is mandatory and saved overrides can inherit again', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { ...settings.llm, agentSdk: { ...settings.llm.agentSdk!, thinking: 'disabled' }, stageSettingsByProvider: { 'cursor-agent': { 'classify-input': { model: 'opus', thinking: 'disabled' } } } };
  const brain = await mockBrain(page, { settings, modelOptions });
  await page.goto('/');
  const dialog = await openSettings(page);
  const thinking = dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true });
  await expect(thinking).toBeEnabled();
  await expect(thinking).toHaveValue('disabled');
  await expect(thinking.locator('option[value="disabled"]')).toBeDisabled();
  await expect(thinking.locator('option').first()).toHaveText('Default (model controlled)');
  await expect(dialog.getByText('The provider has not reported whether thinking can be disabled.')).toBeVisible();
  await expect(dialog.getByText('The saved thinking override is not confirmed as supported by this model. Use the default or choose another model.')).toBeVisible();
  await thinking.selectOption('');
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']?.['classify-input']).toEqual({ model: 'opus' });
});

test('an unavailable workflow explains when its stage list will refresh', async ({ page }) => {
  await mockBrain(page, { modelOptions: { ...modelOptions, stages: [] } });
  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(dialog.getByText('Workflow stages are unavailable. They will be checked at the next research launch.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save models', exact: true })).toBeDisabled();
});

test('unsupported saved reasoning can be reset without discarding model or transcript preferences', async ({ page }) => {
  const settings = defaultTestSettings();
  settings.llm = { ...settings.llm, stageSettingsByProvider: { 'cursor-agent': { 'classify-input': { model: 'custom', effort: 'max', thinking: 'adaptive', transcript: 'off' } } } };
  const brain = await mockBrain(page, { settings, modelOptions });
  await page.goto('/');
  const dialog = await openSettings(page);
  const effort = dialog.getByRole('combobox', { name: 'Classify input reasoning effort', exact: true });
  const thinking = dialog.getByRole('combobox', { name: 'Classify input thinking mode', exact: true });
  await expect(effort).toBeEnabled();
  await expect(effort.locator('option[value="max"]')).toBeDisabled();
  await expect(thinking).toBeEnabled();
  await effort.selectOption('');
  await thinking.selectOption('');
  await dialog.getByRole('button', { name: 'Save models', exact: true }).click();
  await expect.poll(() => brain.settings.llm.stageSettingsByProvider?.['cursor-agent']?.['classify-input']).toEqual({ model: 'custom', transcript: 'off' });
});

test('a provider changed in another window refreshes the shared catalog once', async ({ page }) => {
  const brain = await mockBrain(page, { modelOptions });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open settings menu', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => requests(brain)).toBe(1);
  brain.settings = { ...brain.settings, llm: { ...brain.settings.llm, provider: 'anthropic', stageSettingsByProvider: { anthropic: { 'classify-input': { model: 'opus', effort: 'max' } } } } };
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('combobox', { name: 'Classify input model', exact: true })).toHaveValue('opus');
  await expect.poll(() => requests(brain)).toBe(2);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await openSettings(page);
  expect(requests(brain)).toBe(2);
});

test('the workflow panel remains usable with a full workflow on desktop and mobile', async ({ page }) => {
  const names = ['Prepare input', 'Classify input', 'Read attached code', 'Screen literature', 'Develop proposal', 'Cross-field review (scored)', 'Peer review (scored)', 'Review chair', 'Review chair reassessment', 'Revise proposal (scored)', 'Cross-field review', 'Peer review', 'Review judgement', 'Review reassessment', 'Revise proposal', 'Integration audit', 'Final synthesis', 'Fact verification', 'Fact consultation', 'Fact updates'];
  await mockBrain(page, { modelOptions: { ...modelOptions, stages: names.map((label, index) => ({ id: `stage-${index}`, label, description: `${label} for this research workflow.` })) } });
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('heading', { name: 'Models by pipeline stage', exact: true }).evaluate(element => {
    const content = element.closest<HTMLElement>('.settings-content')!;
    content.scrollTop += element.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
  });
  await expect(dialog.locator('.settings-stage-model')).toHaveCount(20);
  await page.screenshot({ path: '/tmp/co-inference-stage-models-final.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('combobox', { name: 'Classify input model', exact: true }).evaluate(element => {
    const content = element.closest<HTMLElement>('.settings-content')!;
    const card = element.closest<HTMLElement>('.settings-stage-model')!;
    content.scrollTop += card.getBoundingClientRect().top - content.getBoundingClientRect().top - 85;
  });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole('combobox', { name: 'Classify input model', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/co-inference-stage-models-mobile-final.png' });
  await dialog.getByRole('combobox', { name: 'Fact updates model', exact: true }).selectOption('fast');
  await expect(dialog.getByRole('button', { name: 'Save models', exact: true })).toBeEnabled();
});
