import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerSettings } from '@brainstorm-agentic/protocol';
import { projectQuickSetting, quickSettingsPatch } from '../src/components/quick-controls/settings-commands.js';

const settings = (): ServerSettings => ({
  runner: 'slurm', slurmTemplate: '{{BRAIN_COMMAND}}', panelConfirmation: 'manual',
  llm: { provider: 'cursor-agent', cursorApiKeyConfigured: true, agentSdk: { maxTurns: 88, maxBudgetUsd: 12, effort: 'high', thinking: 'adaptive', fallbackModel: 'backup' } },
  contentRegistry: { url: 'https://registry.example', bundle: 'brainstorm' },
  creditRecovery: { autoResume: true, safetyBufferSeconds: 90, openRouterModel: 'parser' },
  hostTools: { enabledToolIds: ['attachment_list', 'attachment_read', 'attachment_search', 'code_execute', 'gpu_run', 'custom_tool'] },
  gpu: { template: '#!/bin/bash\n{{AGENT_COMMAND}}', timeLimitMinutes: 120 },
  panel: { size: 7, interdisciplinarySeat: false },
  webSearch: { provider: 'searxng-local', scholarly: true, cacheEnabled: false, braveKeyConfigured: true, braveFallback: { enabled: true, maxRequestsPerRun: 45, maxRequestsPerMonth: 600 } },
});

test('attachment switches preserve GPU and unrelated tools, including after an intervening edit', () => {
  const current = settings();
  const next = projectQuickSetting(current, { id: 'attachments', value: false });
  assert.deepEqual(next.hostTools?.enabledToolIds, ['code_execute', 'gpu_run', 'custom_tool']);
  const changedElsewhere = { ...next, hostTools: { enabledToolIds: [...next.hostTools!.enabledToolIds, 'new_tool'] } };
  const enabled = quickSettingsPatch(changedElsewhere, { id: 'attachments', value: true });
  assert.deepEqual(enabled.hostTools?.enabledToolIds, ['code_execute', 'gpu_run', 'custom_tool', 'new_tool', 'attachment_list', 'attachment_read', 'attachment_search']);
});

test('reasoning changes preserve task limits and other nested SDK preferences', () => {
  let current = projectQuickSetting(settings(), { id: 'effort', value: 'max' });
  current = projectQuickSetting(current, { id: 'thinking', value: false });
  assert.deepEqual(current.llm.agentSdk, { maxTurns: 88, maxBudgetUsd: 12, effort: 'max', thinking: 'disabled', fallbackModel: 'backup' });
});

test('resetting panel size preserves interdisciplinary selection while review reset uses the bundle', () => {
  const current = settings();
  assert.deepEqual(quickSettingsPatch(current, { id: 'panelSize', value: '' }), { panel: { interdisciplinarySeat: false } });
  assert.deepEqual(quickSettingsPatch(current, { id: 'interdisciplinarySeat', value: true }), { panel: { size: 7, interdisciplinarySeat: true } });
  assert.deepEqual(quickSettingsPatch(current, { id: 'reviewRounds', value: '' }), { review: {} });
});

test('game toggle updates only the new-run mode and preserves review budget', () => {
  const current = { ...settings(), review: { maxRounds: 3 } };
  assert.deepEqual(quickSettingsPatch(current, { id: 'gamifiedReview', value: true }), { gamifiedReview: true });
  const next = projectQuickSetting(current, { id: 'gamifiedReview', value: true });
  assert.equal(next.gamifiedReview, true);
  assert.deepEqual(next.review, { maxRounds: 3 });
  assert.equal(projectQuickSetting(next, { id: 'gamifiedReview', value: false }).gamifiedReview, false);
  assert.throws(() => quickSettingsPatch(current, { id: 'gamifiedReview', value: 'yes' }), /on or off/);
});

test('turning paid fallback off retains its caps; cap edits do not enable it', () => {
  const current = projectQuickSetting(settings(), { id: 'braveFallback', value: false });
  assert.deepEqual(current.webSearch?.braveFallback, { enabled: false, maxRequestsPerRun: 45, maxRequestsPerMonth: 600 });
  assert.deepEqual(quickSettingsPatch(current, { id: 'searchLimits', value: { perRun: '20', perMonth: '200' } }).webSearch?.braveFallback,
    { enabled: false, maxRequestsPerRun: 20, maxRequestsPerMonth: 200 });
});

test('compact task editor can clear optional limits without resetting reasoning preferences', () => {
  const result = quickSettingsPatch(settings(), { id: 'agentLimits', value: { maxTurns: '65', maxBudgetUsd: '', fallbackModel: '' } });
  assert.deepEqual(result.llm?.agentSdk, { maxTurns: 65, effort: 'high', thinking: 'adaptive' });
});

test('GPU ceiling edits cannot bypass draft review and probe approval', () => {
  const current = settings();
  assert.throws(() => quickSettingsPatch(current, { id: 'gpuTime', value: '45' }), /approved probe/);
});

test('invalid numbers and missing setup fail before a settings request can be built', () => {
  const current = settings();
  for (const value of ['', '2.5', '0', '1441', 'Infinity']) assert.throws(() => quickSettingsPatch(current, { id: 'gpuTime', value }));
  assert.throws(() => quickSettingsPatch(current, { id: 'provider', value: 'anthropic' }), /Connect/);
  assert.throws(() => quickSettingsPatch({ ...current, webSearch: { ...current.webSearch!, braveKeyConfigured: false } }, { id: 'braveFallback', value: true }), /Brave key/);
  assert.throws(() => quickSettingsPatch({ ...current, gpu: { template: '', timeLimitMinutes: 60 } }, { id: 'gpuTime', value: 20 }), /GPU setup/);
  assert.throws(() => quickSettingsPatch({ ...current, llm: { provider: 'offline' } }, { id: 'agentLimits', value: { maxTurns: '30' } }), /Agent SDK/);
});

test('Gemini quick selection requires its own verified key and chooses a Gemini default', () => {
  assert.throws(() => quickSettingsPatch(settings(), { id: 'provider', value: 'gemini' }), /Connect/);
  const ready = { ...settings(), llm: { ...settings().llm, geminiApiKeyConfigured: true, transcript: 'off' as const } };
  const selected = projectQuickSetting(ready, { id: 'provider', value: 'gemini' });
  assert.equal(selected.llm.provider, 'gemini');
  assert.equal(selected.llm.model, 'gemini-3.8-flash');
  assert.equal(selected.llm.transcript, 'off');
  assert.throws(() => quickSettingsPatch(selected, { id: 'model', value: '' }), /model name/);
});
