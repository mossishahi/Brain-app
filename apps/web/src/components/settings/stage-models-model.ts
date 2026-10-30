import type { ModelOption, ModelOptionsResponse, StageModelSettings, StageOption } from '@brainstorm-agentic/protocol';

export type StageSettingsMap = Readonly<Record<string, StageModelSettings>>;
export function findModel(models: readonly ModelOption[], id: string | undefined): ModelOption | undefined {
  return models.find(model => model.id === id || (id !== undefined && model.aliases?.includes(id)));
}
export function inheritedStageModel(options: ModelOptionsResponse, stage: StageOption): string | undefined {
  return (stage.route ? options.modelsByRoute[stage.route] : undefined) || options.defaults?.model || options.defaultModel;
}
export function updateStage(settings: StageSettingsMap, id: string, next: StageModelSettings): StageSettingsMap {
  const result = { ...settings };
  const clean: StageModelSettings = {
    ...(next.model ? { model: next.model } : {}),
    ...(next.effort ? { effort: next.effort } : {}),
    ...(next.thinking ? { thinking: next.thinking } : {}),
  };
  if (Object.keys(clean).length) result[id] = clean;
  else delete result[id];
  return result;
}
export function changeStageModel(settings: StageSettingsMap, stage: StageOption, model: string, options: ModelOptionsResponse): StageSettingsMap {
  const current = settings[stage.id] ?? {};
  const capabilities = findModel(options.models, model || inheritedStageModel(options, stage))?.capabilities;
  return updateStage(settings, stage.id, {
    model,
    ...(current.effort && capabilities?.effortLevels.includes(current.effort) ? { effort: current.effort } : {}),
    ...(current.thinking === 'adaptive' && capabilities?.adaptiveThinking ? { thinking: current.thinking }
      : current.thinking === 'disabled' && capabilities?.thinkingCanBeDisabled === true ? { thinking: current.thinking } : {}),
  });
}
export function sameStageSettings(a: StageSettingsMap, b: StageSettingsMap): boolean {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(id =>
    a[id]?.model === b[id]?.model && a[id]?.effort === b[id]?.effort && a[id]?.thinking === b[id]?.thinking);
}
