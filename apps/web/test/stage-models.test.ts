import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelOptionsResponse, StageModelSettings } from '@brainstorm-agentic/protocol';
import { changeStageModel, findModel, inheritedStageModel, sameStageSettings, updateStage } from '../src/components/settings/stage-models-model.js';

const stage = { id: 'classify-input', label: 'Classify input', description: 'Classify the research question', route: 'balanced' };
const options: ModelOptionsResponse = {
  provider: 'claude-agent', modelsByRoute: { balanced: 'balanced-model' }, defaultModel: 'default-model', taskTypes: [],
  models: [
    { id: 'capable', label: 'Capable', aliases: ['capable-alias'], capabilities: { effortLevels: ['low', 'high'], adaptiveThinking: true, thinkingCanBeDisabled: true } },
    { id: 'limited', label: 'Limited', capabilities: { effortLevels: ['low'], adaptiveThinking: true } },
    { id: 'unknown', label: 'Unknown' },
  ],
};
test('inherited model follows route overrides and model aliases find capabilities', () => {
  assert.equal(inheritedStageModel(options, stage), 'balanced-model');
  assert.equal(inheritedStageModel(options, { ...stage, route: undefined }), 'default-model');
  assert.equal(findModel(options.models, 'capable-alias')?.id, 'capable');
});
test('changing a model clears unsupported reasoning and preserves unrelated stages', () => {
  const initial: Record<string, StageModelSettings> = { [stage.id]: { model: 'capable', effort: 'high', thinking: 'disabled' }, hidden: { model: 'custom' } };
  assert.deepEqual(changeStageModel(initial, stage, 'limited', options), { [stage.id]: { model: 'limited' }, hidden: { model: 'custom' } });
  assert.deepEqual(changeStageModel(initial, stage, 'unknown', options), { [stage.id]: { model: 'unknown' }, hidden: { model: 'custom' } });
  assert.deepEqual(changeStageModel(initial, stage, 'capable-alias', options), { ...initial, [stage.id]: { ...initial[stage.id], model: 'capable-alias' } });
  assert.equal(initial[stage.id]?.model, 'capable');
});
test('reset drops only that stage and draft comparisons ignore key order and empty overrides', () => {
  assert.deepEqual(updateStage({ [stage.id]: { effort: 'high' }, hidden: { model: 'keep' } }, stage.id, {}), { hidden: { model: 'keep' } });
  assert.equal(sameStageSettings({ a: { model: 'x', effort: 'low' }, empty: {} }, { a: { effort: 'low', model: 'x' } }), true);
  assert.equal(sameStageSettings({ a: { effort: 'high' } }, { a: { effort: 'low' } }), false);
});
