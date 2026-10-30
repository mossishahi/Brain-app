import type { Page } from '@playwright/test';
import type { GpuSetupReport, JobSummary, ModelOptionsResponse, ReadinessReport, ServerSettings } from '@brainstorm-agentic/protocol';

export function gpuDraftFixture(): GpuSetupReport {
  return {
    phase: 'draft', updatedAt: new Date().toISOString(), progress: { percent: 100, message: 'Draft ready for review' },
    discovery: { hostname: 'submit.example.test', architecture: 'x86_64', platform: 'linux', scheduler: 'slurm', cluster: 'research', discoveredAt: new Date().toISOString(), warnings: [], evidence: [],
      partitions: [{ name: 'gpu_p', accounts: ['standard', 'priority'], qos: ['gpu_normal', 'gpu_priority', 'gpu_reserved'], accountQos: { standard: ['gpu_normal'], priority: ['gpu_priority', 'gpu_reserved'] }, gpuTypes: ['a100'], maxTimeMinutes: 120 }],
      qos: [{ name: 'gpu_normal', flags: [], requiresReservation: false }, { name: 'gpu_priority', flags: [], requiresReservation: false }, { name: 'gpu_reserved', flags: ['RequiresReservation'], requiresReservation: true }] },
    draft: { id: 'test-gpu-draft', revision: 1, reviewToken: 'test-review-1', notes: [],
      parameters: { partition: 'gpu_p', account: 'standard', qos: 'gpu_normal', gpus: 1, cpus: 2, memoryGb: 4, timeLimitMinutes: 10, nice: 0, prelude: '' },
      template: '#!/bin/bash\n#SBATCH --partition=gpu_p\n{{AGENT_COMMAND}}', probeScript: '#!/bin/bash\n#SBATCH --partition=gpu_p\n#SBATCH --qos=gpu_normal\nnvidia-smi\n' },
  };
}

export function makeJob(index = 1, patch: Partial<JobSummary> = {}): JobSummary {
  return { jobId: `test-run-${index}`, topic: `Research question ${index}`, title: `Research record ${index}`, status: 'completed', runner: 'local', createdAt: 1_790_000_000_000 + index, updatedAt: 1_790_000_000_000 + index, ...patch };
}

export function defaultTestSettings(): ServerSettings {
  return {
    slurmTemplate: '#!/bin/bash\n#SBATCH --partition=cpu\n{{BRAIN_COMMAND}}', runner: 'local',
    llm: { provider: 'cursor-agent', model: 'auto', cursorApiKeyConfigured: true, modelsByRoute: {}, agentSdk: { maxTurns: 80, effort: 'high', thinking: 'adaptive' } },
    gpu: { template: '', timeLimitMinutes: 60 }, panelConfirmation: 'manual', gateAutoApprove: true,
    review: { maxRounds: 3 }, panel: { size: 4, interdisciplinarySeat: true },
    contentRegistry: { url: 'https://registry.example.test/mcp', bundle: 'brainstorm', updatePolicy: 'auto' }, updateCheck: 'off',
    creditRecovery: { autoResume: false, safetyBufferSeconds: 60, openRouterModel: 'openrouter/free' }, interruptedRecovery: { autoResume: true },
    telemetry: { enabled: false, ingestUrl: '' }, hostTools: { enabledToolIds: ['web.search', 'web.fetch'] },
    webSearch: { mode: 'host', provider: 'searxng', scholarly: true, cacheEnabled: true, searxngBaseUrl: 'https://search.example.test', routePreset: 'searxng-first', braveFallback: { enabled: false, maxRequestsPerRun: 300, maxRequestsPerMonth: 1000 } },
  };
}

export type MockWrite = { method: string; path: string; body: any };

/** Every API request is fulfilled locally. Unknown routes fail closed. */
export async function mockBrain(page: Page, options: { jobs?: readonly JobSummary[]; trash?: readonly JobSummary[]; settings?: ServerSettings; modelOptions?: Partial<ModelOptionsResponse> } = {}) {
  const state = {
    settings: options.settings ?? defaultTestSettings(),
    modelOptions: options.modelOptions,
    jobs: [...(options.jobs ?? [makeJob(1), makeJob(2)])],
    trash: [...(options.trash ?? [])],
    readiness: { ready: true, updatedAt: Date.now(), checks: [{ id: 'llm', label: 'Model connection', required: true, state: 'ok', message: 'Ready' }] } as ReadinessReport,
    gpuSetup: { phase: 'unconfigured', updatedAt: new Date().toISOString(), progress: { percent: 0, message: 'Waiting for GPU discovery.' } } as GpuSetupReport,
    writes: [] as MockWrite[], requests: [] as { method: string; path: string }[], unhandled: [] as string[],
    failSettings: false as boolean | string,
    failJobs: false as boolean | string,
    failTrash: false as boolean | string,
    failValidation: false,
    settingsDelayMs: 0,
    submitId: 'test-submitted-run',
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api'.length);
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method, path });
    if (method !== 'GET') state.writes.push({ method, path, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/settings' && method === 'GET') return json(state.settings);
    if ((path === '/settings' || path === '/settings/models-by-route' || path === '/settings/stage-models') && method === 'PUT') {
      if (state.settingsDelayMs) await new Promise((resolve) => setTimeout(resolve, state.settingsDelayMs));
      if (state.failSettings) return json({ error: typeof state.failSettings === 'string' ? state.failSettings : 'The settings service is temporarily unavailable.' }, 503);
      if (path.endsWith('stage-models')) {
        if (body.provider !== state.settings.llm.provider) return json({ error: 'The provider changed. Reload model settings.' }, 409);
        state.settings = { ...state.settings, llm: { ...state.settings.llm, stageSettingsByProvider: { ...state.settings.llm.stageSettingsByProvider, [body.provider]: body.stageSettings } } };
      }
      else if (path.endsWith('models-by-route')) state.settings = { ...state.settings, llm: { ...state.settings.llm, modelsByRoute: body.modelsByRoute } };
      else {
        const next = { ...state.settings, ...body };
        // Match SettingsManager.mergeOverStored: these sections merge once;
        // nested policies (agentSdk/braveFallback) and panel/review replace.
        for (const section of ['llm', 'webSearch', 'creditRecovery', 'gpu', 'hostTools'] as const) {
          if (body[section]) next[section] = { ...state.settings[section], ...body[section] };
        }
        if (body.llm) {
          const llm = next.llm;
          for (const [secret, configured] of [['apiKey', 'apiKeyConfigured'], ['setupToken', 'setupTokenConfigured'], ['cursorApiKey', 'cursorApiKeyConfigured']]) {
            if (llm[secret]) llm[configured] = true;
            delete llm[secret];
          }
          next.llm = llm;
        }
        if (body.webSearch) {
          for (const [secret, configured] of [['tavilyApiKey', 'tavilyKeyConfigured'], ['braveApiKey', 'braveKeyConfigured']]) {
            if (next.webSearch[secret]) next.webSearch[configured] = true;
            delete next.webSearch[secret];
          }
        }
        if (body.creditRecovery) {
          if (next.creditRecovery.openRouterApiKey) next.creditRecovery.openRouterKeyConfigured = true;
          delete next.creditRecovery.openRouterApiKey;
        }
        state.settings = next;
      }
      return json(state.settings);
    }
    if (path === '/health') return json({ ok: true, version: '0.1.0', workspace: '/test-workspace', contentRegistry: { running: true, url: 'https://registry.example.test/mcp', bundle: 'brainstorm', effectiveVersion: '0.1.0', serverVersion: '0.1.0' } });
    if (path === '/gpu/setup' && method === 'GET') return json(state.gpuSetup);
    if (path === '/gpu/discover' && method === 'POST') {
      state.gpuSetup = { ...state.gpuSetup, phase: 'discovering', progress: { percent: 25, message: 'Inspecting host and scheduler' } };
      return json(state.gpuSetup, 202);
    }
    if (path === '/gpu/draft' && method === 'PUT') {
      const draft = state.gpuSetup.draft;
      if (!draft || body.draftId !== draft.id || body.revision !== draft.revision) return json({ error: 'The GPU draft has changed. Refresh before approving.' }, 409);
      const revision = draft.revision + 1;
      state.gpuSetup = { ...state.gpuSetup, phase: 'draft', draft: { ...draft, revision, reviewToken: `test-review-${revision}`, parameters: body.parameters,
        probeScript: `#!/bin/bash\n#SBATCH --partition=${body.parameters.partition}\n#SBATCH --qos=${body.parameters.qos}\n${body.parameters.prelude}\nnvidia-smi\n` } };
      return json(state.gpuSetup);
    }
    if (path === '/gpu/probe' && method === 'POST') {
      const draft = state.gpuSetup.draft;
      if (!draft || body.draftId !== draft.id || body.revision !== draft.revision || body.reviewToken !== draft.reviewToken || body.approved !== true) return json({ error: 'The GPU draft has changed. Refresh before approving.' }, 409);
      state.gpuSetup = { ...state.gpuSetup, phase: 'probing', progress: { percent: 50, message: 'Probe queued' }, probe: { state: 'PENDING', jobId: '12345', startedAt: new Date().toISOString() } };
      return json(state.gpuSetup, 202);
    }
    if (path === '/gpu/cancel' && method === 'POST') {
      state.gpuSetup = { ...state.gpuSetup, phase: 'draft', cleanupRequired: false, probe: { ...state.gpuSetup.probe!, state: 'CANCELLED', finishedAt: new Date().toISOString() } };
      return json(state.gpuSetup);
    }
    if (path === '/update-check') return json({ version: '0.1.0', selfUpdateEnabled: false });
    if (path.startsWith('/readiness')) return json(state.readiness);
    if (path === '/model-options') return json({ defaultModel: 'auto', taskTypes: [{ id: 'review', description: 'Scientific review' }, { id: 'synthesis', description: 'Combine perspectives' }], models: [{ id: 'auto', label: 'Auto', capabilities: { effortLevels: ['low', 'medium', 'high'], adaptiveThinking: true, thinkingCanBeDisabled: true } }, { id: 'review-model', label: 'Review model' }],
      ...state.modelOptions, provider: state.settings.llm.provider, modelsByRoute: state.settings.llm.modelsByRoute ?? {},
      ...(state.modelOptions?.stages ? { stageSettings: state.settings.llm.stageSettingsByProvider?.[state.settings.llm.provider] ?? {}, defaults: { model: state.settings.llm.model, effort: state.settings.llm.agentSdk?.effort, thinking: state.settings.llm.agentSdk?.thinking } } : {}),
    });
    if (path === '/capabilities') return json({ version: 'test', capabilities: [{ id: 'web-search', description: 'Find supporting material', operations: ['web.search'], locked: false }, { id: 'code-execution', description: 'Run calculations', operations: ['code.run'], locked: false }, { id: 'taxonomy-access', description: 'Required taxonomy', operations: ['taxonomy.get'], locked: true }] });
    if (path === '/jobs' && method === 'GET') return state.failJobs
      ? json({ error: typeof state.failJobs === 'string' ? state.failJobs : 'Research history is temporarily unavailable.' }, 503)
      : json(state.jobs);
    if (path === '/jobs' && method === 'POST') {
      if (!state.readiness.ready) return json({ message: 'Environment is not ready', readiness: state.readiness }, 409);
      state.jobs.unshift(makeJob(10_001, { jobId: state.submitId, topic: body.topic, title: undefined, attachments: body.attachments ?? [], status: 'queued' }));
      return json({ jobId: state.submitId });
    }
    if (path === '/jobs/trash') return state.failTrash
      ? json({ error: typeof state.failTrash === 'string' ? state.failTrash : 'Trash is temporarily unavailable.' }, 503)
      : json(state.trash);
    if (path === '/attachments/validate') {
      if (state.failValidation) return json({ error: 'The attachment server could not be reached.' }, 503);
      return json({ attachments: body.paths.map((path: string) => ({ path, name: path.split('/').filter(Boolean).at(-1) ?? path, kind: body.kind, valid: !path.includes('invalid'), readable: !path.includes('invalid'), bytes: 1200, ...(path.includes('invalid') ? { reason: 'The reference is unavailable.' } : {}) })) });
    }
    if (path === '/attachments/roots') return json({ roots: [{ id: 'workspace', label: 'Workspace', path: '/test-workspace' }] });
    if (path === '/attachments/browse') return json({ roots: [{ id: 'workspace', label: 'Workspace', path: '/test-workspace' }], rootId: 'workspace', currentPath: '/test-workspace', entries: [{ name: 'reference.pdf', path: '/test-workspace/reference.pdf', kind: 'file', bytes: 1200, modifiedAt: Date.now(), selectable: true }] });
    if (path === '/stream' || path.endsWith('/stream')) {
      const jobId = path.split('/')[2];
      const job = [...state.jobs, ...state.trash].find((item) => item.jobId === jobId);
      const events = path === '/stream' ? [{ type: 'jobs', jobs: state.jobs }, { type: 'readiness', readiness: state.readiness }] : [{ type: 'job', job: { ...(job ?? makeJob(1)), stages: [] } }];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') });
    }
    const detail = /^\/jobs\/([^/]+)$/.exec(path);
    if (detail) return json({ ...([...state.jobs, ...state.trash].find((item) => item.jobId === decodeURIComponent(detail[1]!)) ?? makeJob(1)), stages: [] });
    if (/\/stages\/[^/]+\/activity/.test(path)) return json({ entries: [], total: 0 });
    if (path.endsWith('/tool-usage')) return json({ totals: {}, failures: {}, byRole: {}, byStage: {}, capabilityResolution: {} });
    if (/\/jobs\/[^/]+\/(pause|resume-paused|resume-interrupted|cancel|trash|retry|gate|gate-hold)$/.test(path)) return json({ jobId: path.split('/')[2], status: 'paused' });
    state.unhandled.push(`${method} ${path}`);
    return json({ error: `No browser-test fixture for ${method} ${path}` }, 501);
  });
  return state;
}
