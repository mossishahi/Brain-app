import type { ClaudeAgentSettings, ServerSettings, ServerSettingsUpdate } from '@brainstorm-agentic/protocol';

export type QuickSetting = 'provider' | 'model' | 'effort' | 'thinking' | 'agentLimits' | 'panelConfirmation'
  | 'gateAutoApprove' | 'gamifiedReview' | 'gameDecisionRule' | 'gameLeaveOneOut' | 'reviewRounds' | 'panelSize' | 'interdisciplinarySeat' | 'attachments' | 'hostCode'
  | 'searchMode' | 'searchProvider' | 'scholarly' | 'cache' | 'braveFallback' | 'searchLimits' | 'contactEmail'
  | 'runner' | 'gpuTime' | 'resumeInterrupted' | 'resumeCredit' | 'recoveryBuffer' | 'updateCheck';
export type QuickValue = string | number | boolean | Readonly<Record<string, string>>;
export type QuickCommand = { id: QuickSetting; value: QuickValue };
export const agentDefaults: ClaudeAgentSettings = { maxTurns: 100, effort: 'high', thinking: 'adaptive' };

function choice<const T extends readonly string[]>(value: QuickValue, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) throw new Error('Choose one of the available options.');
  return value;
}
function flag(value: QuickValue): boolean {
  if (typeof value !== 'boolean') throw new Error('Choose on or off.');
  return value;
}
function integer(value: QuickValue, min: number, max: number): number {
  if (typeof value === 'boolean' || typeof value === 'object' || String(value).trim() === '') throw new Error('Enter a whole number.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Enter a whole number from ${min} to ${max}.`);
  return number;
}
function fields(value: QuickValue): Readonly<Record<string, string>> {
  if (typeof value !== 'object') throw new Error('Enter the requested values.');
  return value;
}
export function providerConfigured(settings: ServerSettings, provider: ServerSettings['llm']['provider']): boolean {
  return provider === 'offline' || (provider === 'anthropic' ? settings.llm.apiKeyConfigured === true
    : provider === 'claude-agent' ? settings.llm.setupTokenConfigured === true : settings.llm.cursorApiKeyConfigured === true);
}
export function hostTools(settings: ServerSettings): readonly string[] {
  return settings.hostTools?.enabledToolIds ?? ['attachment_list', 'attachment_read', 'attachment_search'];
}

/** Field-specific operations preserve sibling fields that the server treats as replacement policies. */
export function quickSettingsPatch(s: ServerSettings, { id, value }: QuickCommand): ServerSettingsUpdate {
  const agent = { ...agentDefaults, ...s.llm.agentSdk };
  const web = s.webSearch;
  const webProvider = web?.provider ?? 'none';
  const agentPatch = (patch: Partial<ClaudeAgentSettings>): ServerSettingsUpdate => {
    if (s.llm.provider !== 'claude-agent' && s.llm.provider !== 'cursor-agent') throw new Error('These controls require an Agent SDK provider.');
    return { llm: { provider: s.llm.provider, agentSdk: { ...agent, ...patch } } };
  };
  switch (id) {
    case 'provider': {
      const provider = choice(value, ['anthropic', 'claude-agent', 'cursor-agent', 'offline']);
      if (!providerConfigured(s, provider)) throw new Error('Connect this provider before selecting it.');
      return { llm: { provider, ...(provider !== s.llm.provider ? { model: provider === 'anthropic' ? 'claude-sonnet-5' : '', baseUrl: '' } : {}) } };
    }
    case 'model': {
      if (s.llm.provider === 'offline') throw new Error('Offline research does not select a model.');
      if (typeof value !== 'string' || (s.llm.provider === 'anthropic' && !value.trim())) throw new Error('Enter a model name.');
      return { llm: { provider: s.llm.provider, model: value.trim() } };
    }
    case 'effort': return agentPatch({ effort: choice(value, ['low', 'medium', 'high', 'xhigh', 'max']) });
    case 'thinking': return agentPatch({ thinking: flag(value) ? 'adaptive' : 'disabled' });
    case 'agentLimits': {
      if (s.llm.provider !== 'claude-agent' && s.llm.provider !== 'cursor-agent') throw new Error('Task limits require an Agent SDK provider.');
      const input = fields(value);
      const maxTurns = integer(input.maxTurns ?? '', 1, 500);
      const budgetText = (input.maxBudgetUsd ?? '').trim();
      const maxBudgetUsd = budgetText ? Number(budgetText) : undefined;
      if (maxBudgetUsd !== undefined && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)) throw new Error('The task budget must be a positive USD amount, or empty for no cap.');
      const { maxBudgetUsd: _budget, fallbackModel: _fallback, ...rest } = agent;
      const fallbackModel = (input.fallbackModel ?? '').trim();
      return { llm: { provider: s.llm.provider, agentSdk: { ...rest, maxTurns, ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}), ...(fallbackModel ? { fallbackModel } : {}) } } };
    }
    case 'panelConfirmation': return { panelConfirmation: choice(value, ['manual', 'auto']) };
    case 'gateAutoApprove': return { gateAutoApprove: flag(value) };
    case 'gamifiedReview': return { gamifiedReview: flag(value) };
    // The server replaces the whole gameReview section, so every patch carries it in full.
    case 'gameDecisionRule': return { gameReview: { ...s.gameReview, threshold: s.gameReview?.threshold ?? 0.5, decisionRule: choice(value, ['committee-mean', 'chair-decisive']) } };
    case 'gameLeaveOneOut': {
      if ((s.gameReview?.decisionRule ?? 'chair-decisive') === 'chair-decisive') throw new Error("not applicable: the chair label does not depend on the critics' numbers");
      return { gameReview: { ...s.gameReview, threshold: s.gameReview?.threshold ?? 0.5, leaveOneOut: flag(value) } };
    }
    case 'reviewRounds': return { review: value === '' ? {} : { maxRounds: integer(value, 1, 10) } };
    case 'panelSize': {
      const { size: _size, ...other } = s.panel ?? {};
      return { panel: { ...other, ...(value === '' ? {} : { size: integer(value, 2, 12) }) } };
    }
    case 'interdisciplinarySeat': return { panel: { ...s.panel, interdisciplinarySeat: flag(value) } };
    case 'attachments':
    case 'hostCode': {
      const group = id === 'attachments' ? ['attachment_list', 'attachment_read', 'attachment_search'] : ['code_execute'];
      return { hostTools: { enabledToolIds: flag(value) ? [...new Set([...hostTools(s), ...group])] : hostTools(s).filter(tool => !group.includes(tool)) } };
    }
    case 'searchMode': return { webSearch: { provider: webProvider, mode: choice(value, ['host', 'agent']) } };
    case 'searchProvider': {
      const provider = choice(value, ['none', 'tavily', 'brave', 'searxng', 'searxng-local']);
      if ((provider === 'tavily' && !web?.tavilyKeyConfigured) || (provider === 'brave' && !web?.braveKeyConfigured) || (provider === 'searxng' && !web?.searxngBaseUrl)) throw new Error('Set up this search provider before selecting it.');
      return { webSearch: { provider } };
    }
    case 'scholarly': return { webSearch: { provider: webProvider, scholarly: flag(value) } };
    case 'cache': return { webSearch: { provider: webProvider, cacheEnabled: flag(value) } };
    case 'braveFallback': {
      if (flag(value) && !web?.braveKeyConfigured) throw new Error('Set up a Brave key before enabling paid fallback.');
      return { webSearch: { provider: webProvider, braveFallback: { ...web?.braveFallback, enabled: flag(value) } } };
    }
    case 'searchLimits': {
      const input = fields(value);
      return { webSearch: { provider: webProvider, braveFallback: { ...web?.braveFallback, enabled: web?.braveFallback?.enabled ?? false, maxRequestsPerRun: integer(input.perRun ?? '', 0, Number.MAX_SAFE_INTEGER), maxRequestsPerMonth: integer(input.perMonth ?? '', 0, Number.MAX_SAFE_INTEGER) } } };
    }
    case 'contactEmail': {
      const contactEmail = String(value).trim();
      if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new Error('Enter a valid email address, or leave it empty.');
      return { webSearch: { provider: webProvider, contactEmail } };
    }
    case 'runner': return { runner: choice(value, ['slurm', 'local']) };
    case 'gpuTime': throw new Error('GPU limits require a reviewed draft and an approved probe. Open GPU setup.');
    case 'resumeInterrupted': return { interruptedRecovery: { autoResume: flag(value) } };
    case 'resumeCredit': return { creditRecovery: { ...s.creditRecovery, autoResume: flag(value) } };
    case 'recoveryBuffer': return { creditRecovery: { ...s.creditRecovery, safetyBufferSeconds: integer(value, 0, 3600) } };
    case 'updateCheck': return { updateCheck: flag(value) ? 'notify' : 'off' };
  }
}

/** Optimistic presentation only; the server remains authoritative after saving. */
export function projectQuickSetting(current: ServerSettings, command: QuickCommand): ServerSettings {
  const patch = quickSettingsPatch(current, command);
  const next = { ...current, ...patch } as ServerSettings;
  for (const name of ['llm', 'webSearch', 'hostTools', 'gpu', 'creditRecovery'] as const) {
    if (patch[name]) Object.assign(next, { [name]: { ...current[name], ...patch[name] } });
  }
  return next;
}
