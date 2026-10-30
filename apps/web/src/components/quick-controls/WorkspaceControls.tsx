import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { errorMessage, postUpdateCheck, useModelOptions } from '../../api';
import { findModel } from '../settings/stage-models-model';
import { loadOptionalModule } from '../../optional-module';
import { backgroundOptions, setAppearance, useAppearance } from '../../backgrounds';
import { settingsCategories, type SettingsCategory } from '../settings/catalog';
import { approvalPreferenceDescription, askBeforeApprovalLabel } from '../settings/approval-preference';
import { QuickControls } from './QuickControls';
import { QuickEditorBoundary } from './QuickEditorBoundary';
import type { QuickControlItem } from './types';
import { agentDefaults, hostTools, providerConfigured, type QuickSetting } from './settings-commands';
import { changeQuickSetting, loadQuickSettings, useQuickSettings } from './settings-store';
import type { QuickEditorId } from './QuickSettingsEditor';

const QuickSettingsEditor = lazy(() => loadOptionalModule(() => import('./QuickSettingsEditor')).then(module => ({ default: module.QuickSettingsEditor })));
const editorCategory: Record<QuickEditorId, SettingsCategory> = {
  model: 'connections', modelsByTask: 'stageModels', agentLimits: 'connections', searchLimits: 'tools',
  contactEmail: 'tools', recoveryBuffer: 'recovery', appInfo: 'updates',
};
const future = 'Defaults for new research';
const live = 'Applies to existing runs';
const local = 'This browser';
const providers = [
  { value: 'anthropic', label: 'Anthropic API' }, { value: 'claude-agent', label: 'Claude Agent SDK' },
  { value: 'cursor-agent', label: 'Cursor SDK' }, { value: 'offline', label: 'Offline' },
] as const;

export function WorkspaceControls({ open, onOpenChange, onOpenSettings }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenSettings: (category: SettingsCategory) => void }) {
  const state = useQuickSettings();
  const modelOptions = useModelOptions().value;
  const appearance = useAppearance();
  const [editor, setEditor] = useState<QuickEditorId | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkStatus, setCheckStatus] = useState<string>();
  const [checkError, setCheckError] = useState<string>();
  useEffect(() => { if (open) void loadQuickSettings(); }, [open]);
  useEffect(() => {
    if (!editor) return;
    // Loading an optional editor must not reopen it over newer work or move
    // focus away after the user has already returned to the workspace.
    const dismissPending = (event: Event) => {
      if (document.querySelector('.quick-editor')) return;
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return;
      const target = event.target;
      if (event.type === 'focusin' && (!(target instanceof Element) || target.closest('#canvas-settings-trigger, .quick-controls-popup'))) return;
      setEditor(null);
    };
    document.addEventListener('pointerdown', dismissPending, true);
    document.addEventListener('keydown', dismissPending, true);
    document.addEventListener('focusin', dismissPending, true);
    return () => {
      document.removeEventListener('pointerdown', dismissPending, true);
      document.removeEventListener('keydown', dismissPending, true);
      document.removeEventListener('focusin', dismissPending, true);
    };
  }, [editor]);
  function configure(category: SettingsCategory) { setEditor(null); onOpenChange(false); onOpenSettings(category); }
  function edit(id: QuickEditorId) { onOpenChange(false); setEditor(id); }
  async function checkUpdates() {
    if (checking) return;
    setChecking(true); setCheckStatus(undefined); setCheckError(undefined);
    try {
      const result = await postUpdateCheck();
      window.dispatchEvent(new Event('brain-check-updates'));
      setCheckStatus(result.appUpdate ? `Version ${result.appUpdate.version} is available. Use the update notification to install.`
        : !result.selfUpdateEnabled ? `Running ${result.version}. Update checks are disabled by this deployment.` : `Version ${result.version} is up to date.`);
    } catch (error) { setCheckError(errorMessage(error)); }
    finally { setChecking(false); }
  }

  const items = useMemo<QuickControlItem[]>(() => {
    const s = state.data;
    const action = (id: string, label: string, onSelect: () => void, extra: Partial<QuickControlItem> = {}): QuickControlItem => ({ kind: 'action', id, label, onSelect, ...extra } as QuickControlItem);
    const editorAction = (id: QuickEditorId, label: string, value?: string): QuickControlItem => action(`edit-${id}`, label, () => edit(id), { value });
    const setup = (category: SettingsCategory, label: string): QuickControlItem => action(`configure-${category}`, label, () => configure(category));
    const toggle = (id: QuickSetting, label: string, checked: boolean, description?: string, scope = '', disabled = false, reason?: string): QuickControlItem => ({
      kind: 'toggle', id, label, checked, description, scope, disabled, reason, ...state.status[id], onChange: value => { void changeQuickSetting(id, value); },
    });
    const selection = (id: QuickSetting, label: string, current: string, options: readonly { value: string; label: string; disabled?: boolean; reason?: string }[], description?: string): QuickControlItem => ({
      kind: 'submenu', id, label, value: options.find(option => option.value === current)?.label ?? current, description, ...state.status[id],
      children: options.map(option => ({ kind: 'choice', id: `${id}-${option.value || 'default'}`, label: option.label, selected: option.value === current,
        disabled: option.disabled || state.status[id]?.pending, reason: option.reason, onSelect: () => { void changeQuickSetting(id, option.value); } })),
    });
    const appearanceChoice = (id: 'theme' | 'background' | 'quality', label: string, options: readonly { value: string; label: string }[]): QuickControlItem => ({
      kind: 'submenu', id, label, value: options.find(option => option.value === appearance[id])?.label,
      children: options.map(option => ({ kind: 'choice', id: `${id}-${option.value}`, label: option.label, selected: appearance[id] === option.value,
        onSelect: () => setAppearance({ [id]: option.value } as Parameters<typeof setAppearance>[0]) })),
    });
    const groups: Partial<Record<SettingsCategory, QuickControlItem[]>> = {
      stageModels: [setup('stageModels', 'Configure stage models…')],
      appearance: [
        appearanceChoice('theme', 'Theme', [{ value: 'system', label: 'Follow system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]),
        appearanceChoice('background', 'Background', backgroundOptions.map(option => ({ value: option.id, label: option.label }))),
        { kind: 'toggle', id: 'motion', label: 'Animate background', checked: appearance.motion,
          disabled: appearance.background === 'none' || appearance.reducedMotion,
          reason: appearance.reducedMotion ? 'Your device requests reduced motion.' : appearance.background === 'none' ? 'Choose a background first.' : undefined,
          onChange: motion => setAppearance({ motion }) },
        { ...appearanceChoice('quality', 'Animation quality', [{ value: 'balanced', label: 'Balanced' }, { value: 'low', label: 'Low power' }]), disabled: appearance.background === 'none', reason: appearance.background === 'none' ? 'Choose a background first.' : undefined },
        ...(!appearance.persisted ? [action('appearance-persistence', 'Preferences are not saved', () => {}, { disabled: true, description: 'Browser storage is unavailable. Changes apply in this tab.' })] : []),
      ],
      updates: [
        action('check-updates', 'Check for updates', () => { void checkUpdates(); }, { keepOpen: true, pending: checking, description: checkStatus, error: checkError }),
        ...(s ? [toggle('updateCheck', 'Notify about app updates', s.updateCheck !== 'off', 'Switch off for manual checks only.', 'This deployment'), editorAction('appInfo', 'App & registry information…')] : []),
      ],
    };
    if (s) {
      const agent = { ...agentDefaults, ...s.llm.agentSdk };
      const sdk = s.llm.provider === 'claude-agent' || s.llm.provider === 'cursor-agent';
      const capabilities = modelOptions?.provider === s.llm.provider
        ? findModel(modelOptions.models, s.llm.model || modelOptions.defaults?.model || modelOptions.defaultModel)?.capabilities : undefined;
      const web = s.webSearch;
      const host = web?.mode !== 'agent';
      const hostReason = host ? undefined : 'Uses the app search tools. Agent-native search is currently selected.';
      const tools = hostTools(s);
      const game = s.gamifiedReview === true;
      const gameRule = s.gameReview?.decisionRule ?? 'chair-decisive';
      const gameReason = game ? undefined : 'Turn on Gamified review first.';
      groups.connections = [
        { kind: 'submenu', id: 'provider', label: 'Provider', value: providers.find(provider => provider.value === s.llm.provider)?.label, ...state.status.provider,
          children: providers.map(provider => providerConfigured(s, provider.value)
            ? { kind: 'choice', id: `provider-${provider.value}`, label: provider.label, selected: s.llm.provider === provider.value, disabled: state.status.provider?.pending, onSelect: () => { void changeQuickSetting('provider', provider.value); } }
            : action(`provider-${provider.value}`, `${provider.label}…`, () => configure('connections'), { description: 'Set up a connection first.' })) },
        { ...editorAction('model', 'Default model…', s.llm.model ?? 'Provider default'), disabled: s.llm.provider === 'offline', reason: s.llm.provider === 'offline' ? 'Offline research uses no model.' : undefined },
        { ...(modelOptions?.stages ? action('edit-stage-models', 'Models by workflow stage…', () => configure('stageModels')) : editorAction('modelsByTask', 'Models by task type…')), disabled: s.llm.provider === 'offline' },
        ...(sdk ? [{ ...selection('effort', 'Reasoning effort', agent.effort, (capabilities?.effortLevels ?? []).map(value => ({ value, label: value === 'xhigh' ? 'Extra high' : value[0]!.toUpperCase() + value.slice(1) })), 'Default for stages using this model.'), disabled: !capabilities?.effortLevels.length, reason: 'Supported reasoning levels depend on the selected model.' },
          toggle('thinking', 'Extended thinking', capabilities?.adaptiveThinking === true && (capabilities.thinkingCanBeDisabled === false || agent.thinking !== 'disabled'), 'Default adaptive thinking for new research.', '', !capabilities?.adaptiveThinking || capabilities.thinkingCanBeDisabled !== true, 'A thinking switch is not available for this model.'), editorAction('agentLimits', 'Task limits & fallback…', `${agent.maxTurns} turns`)] : []),
        setup('connections', 'Configure connections…'),
      ];
      groups.research = [
        { kind: 'toggle', id: 'panelConfirmation', label: askBeforeApprovalLabel, checked: s.panelConfirmation === 'manual',
          description: approvalPreferenceDescription(s.panelConfirmation, s.gateAutoApprove !== false), ...state.status.panelConfirmation,
          onChange: ask => { void changeQuickSetting('panelConfirmation', ask ? 'manual' : 'auto'); } },
        toggle('gateAutoApprove', 'Continue after countdown', s.gateAutoApprove !== false, 'Unanswered gates continue after about 30 seconds. Off means always wait for you.', 'Applies immediately to active runs'),
        toggle('gamifiedReview', 'Gamified review', s.gamifiedReview === true, 'New runs: probability reports, chair decisions and observational scores. Requires a compatible Brain bundle.'),
        { ...selection('gameDecisionRule', 'Decision rule', gameRule, [{ value: 'chair-decisive', label: 'Chair decisive' }, { value: 'committee-mean', label: 'Committee mean' }], 'Chair decisive: any admitted decisive argument blocks. Committee mean: the mean admitted probability against the threshold.'),
          disabled: !game, reason: gameReason },
        toggle('gameLeaveOneOut', 'Leave-one-out scoring', s.gameReview?.leaveOneOut !== false, 'Under committee mean, each critic is scored against the label the other admitted reports produce.', '',
          !game || gameRule === 'chair-decisive', gameReason ?? (gameRule === 'chair-decisive' ? "not applicable: the chair label does not depend on the critics' numbers" : undefined)),
        selection('reviewRounds', 'Review rounds', s.review?.maxRounds === undefined ? '' : String(s.review.maxRounds), [{ value: '', label: 'Bundle default' }, ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} ${index ? 'rounds' : 'round'}` }))]),
        selection('panelSize', 'Panel size', s.panel?.size === undefined ? '' : String(s.panel.size), [{ value: '', label: 'Bundle default' }, ...Array.from({ length: 11 }, (_, index) => ({ value: String(index + 2), label: `${index + 2} seats` }))]),
        toggle('interdisciplinarySeat', 'Interdisciplinary seat', s.panel?.interdisciplinarySeat !== false, 'One extra seat connecting the selected fields.'),
      ];
      const searchProviders = [
        { value: 'none', label: 'Scholarly only', ready: true }, { value: 'searxng-local', label: 'App-managed SearXNG', ready: true },
        { value: 'tavily', label: 'Tavily', ready: web?.tavilyKeyConfigured }, { value: 'brave', label: 'Brave', ready: web?.braveKeyConfigured },
        { value: 'searxng', label: 'Own SearXNG instance', ready: !!web?.searxngBaseUrl },
      ];
      groups.tools = [
        toggle('attachments', 'Attachment access', tools.includes('attachment_list') && tools.includes('attachment_read'), 'List, read and search submission files.'),
        toggle('hostCode', 'Host code execution', tools.includes('code_execute'), 'Provider-native execution remains available.'),
        selection('searchMode', 'Search tools', web?.mode ?? 'host', [{ value: 'host', label: 'App tools' }, { value: 'agent', label: 'Agent-native tools' }], host ? 'Coordinated across agents and logged.' : 'The app search settings and search log do not apply.'),
        { kind: 'submenu', id: 'searchProvider', label: 'Search provider', value: searchProviders.find(provider => provider.value === (web?.provider ?? 'none'))?.label,
          description: web?.provider === 'searxng-local' ? 'Starts the service on this machine. Readiness is shown in Settings → Tools & sources.' : undefined,
          disabled: !host, reason: hostReason, ...state.status.searchProvider,
          children: searchProviders.map(provider => provider.ready
            ? { kind: 'choice', id: `search-${provider.value}`, label: provider.label, selected: (web?.provider ?? 'none') === provider.value, disabled: state.status.searchProvider?.pending, onSelect: () => { void changeQuickSetting('searchProvider', provider.value); } }
            : action(`search-${provider.value}`, `${provider.label}…`, () => configure('tools'), { description: 'Set up this source first.' })) },
        toggle('scholarly', 'Scholarly indexes', web?.scholarly !== false, 'OpenAlex, Crossref, arXiv and Semantic Scholar.', '', !host, hostReason),
        toggle('cache', 'Cache search results', web?.cacheEnabled === true, `${web?.cacheTtlHours ?? 24}-hour keyword cache across runs.`, '', !host, hostReason),
        toggle('braveFallback', 'Paid Brave fallback', web?.braveFallback?.enabled === true, `${web?.braveFallback?.maxRequestsPerRun ?? 300} requests/run · ${web?.braveFallback?.maxRequestsPerMonth ?? 1000}/month`, '', !host || (!web?.braveKeyConfigured && !web?.braveFallback?.enabled), !host ? hostReason : !web?.braveKeyConfigured ? 'Configure a Brave key before enabling paid fallback.' : undefined),
        { ...editorAction('searchLimits', 'Paid search limits…'), disabled: !host, reason: hostReason },
        { ...editorAction('contactEmail', 'Scholarly contact…'), disabled: !host, reason: hostReason },
        setup('tools', 'Configure search connections…'),
      ];
      groups.execution = [
        selection('runner', 'Runner', s.runner, [{ value: 'slurm', label: 'Slurm', disabled: !s.slurmTemplate.includes('{{BRAIN_COMMAND}}'), reason: !s.slurmTemplate.includes('{{BRAIN_COMMAND}}') ? 'Configure the Slurm template first.' : undefined }, { value: 'local', label: 'Local — this machine' }]),
        setup('execution', 'Configure GPU execution…'),
        setup('execution', 'Edit execution templates…'),
      ];
      groups.recovery = [
        toggle('resumeInterrupted', 'Resume interrupted jobs', s.interruptedRecovery?.autoResume !== false, 'Continue from the last checkpoint after interruptions.'),
        toggle('resumeCredit', 'Resume after credit resets', s.creditRecovery.autoResume, 'Continue blocked research after provider credits reset.'),
        editorAction('recoveryBuffer', 'Safety buffer…', `${s.creditRecovery.safetyBufferSeconds} sec`),
        setup('recovery', 'Configure recovery parser…'),
      ];
    }
    return settingsCategories.map(category => ({ kind: 'submenu', id: category.id, label: category.label, contentDescription: category.id === 'appearance' ? local : category.id === 'recovery' ? live : category.id === 'updates' ? 'This deployment' : future,
      children: groups[category.id] ?? [action(`load-${category.id}`, state.loading ? 'Loading settings…' : 'Retry loading settings', () => { void loadQuickSettings(); }, { keepOpen: true, disabled: state.loading, error: state.error }), setup(category.id, 'Open settings…')] }));
  }, [state, modelOptions, appearance, checking, checkStatus, checkError, onOpenSettings, onOpenChange]);

  return <>
    <QuickControls open={open} onOpenChange={next => { if (next) setEditor(null); onOpenChange(next); }} items={items} loading={state.loading && !state.data} error={state.error}
      footer={[{ kind: 'action', id: 'all-settings', label: 'All settings…', onSelect: () => configure('connections') }]} />
    {editor && state.data && <QuickEditorBoundary key={editor} onClose={() => setEditor(null)} onConfigure={() => configure(editorCategory[editor])}><Suspense fallback={<span className="canvas-rail-label" role="status">Opening editor…</span>}><QuickSettingsEditor id={editor} settings={state.data} onClose={() => setEditor(null)} /></Suspense></QuickEditorBoundary>}
  </>;
}
