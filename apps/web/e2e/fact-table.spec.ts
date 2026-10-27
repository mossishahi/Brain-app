import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { DoneStage, FactEntryView, FactTableView, JobDetail } from '@brainstorm-agentic/protocol';
import { makeJob, mockBrain } from './fixtures';

const HASH = `sha256:${'a0123456789bcdef'.repeat(4)}`;
const PROOF = 'For every real x, x² ≥ 0. Hence 1 + x² ≥ 1.\nThe denominator is strictly positive, so the stated division is defined.';
const REASON = 'The complete proof establishes the denominator bound over the stated domain.';
const CLAIM = 'The denominator is at least one.';
const REFERENCE_URLS = {
  claim: 'https://research.example.test/bound',
  conditions: 'https://research.example.test/domain',
  proof: 'https://research.example.test/proof?case=1#lemma',
  bare: 'https://research.example.test/check',
  parentheses: 'https://research.example.test/lemma_(bound)',
  reason: 'https://research.example.test/derivation',
  history: 'https://research.example.test/review-log',
  purpose: 'https://research.example.test/review-plan',
};
const EVIDENCE = `${PROOF}\nReferences: [Proof notes](${REFERENCE_URLS.proof}), (${REFERENCE_URLS.bare}). Also ${REFERENCE_URLS.parentheses}.`;
const PURPOSE = 'Audit the boundary inference before accepting the repair.';
const TIME = 1_790_000_000_000;
const panel = (page: Page) => page.getByRole('region', { name: 'Fact table', exact: true });
const table = (page: Page) => panel(page).getByRole('table', { name: 'Recorded facts', exact: true });
const evidence = (page: Page) => panel(page).locator('dt:has-text("Evidence") + dd');

function facts(): FactEntryView[] {
  return [
    { id: 'F:1', badgeHash: HASH, status: 'justified', kind: 'math', claim: `${CLAIM} [Bound statement](${REFERENCE_URLS.claim})`,
      conditions: `x is a real number; denominator = 1 + x². [Domain](${REFERENCE_URLS.conditions})`, method: 'judgement-only',
      evidence: EVIDENCE, reason: `${REASON} [Derivation notes](${REFERENCE_URLS.reason})`,
      uses: [
        { agentId: 'geometry-reviewer-2', agentLabel: 'Geometry reviewer', role: 'game-commentor',
          seatId: 'algebra-thinker-1', seatLabel: 'Algebra thinker', step: 2,
          purpose: `${PURPOSE} [Review plan](${REFERENCE_URLS.purpose})`, kind: 'submitted', taskId: 'review-task-2', at: TIME },
        { agentId: 'algebra-thinker-1', agentLabel: 'Algebra thinker', role: 'brain', step: 1,
          purpose: 'Establish the denominator before dividing.', kind: 'cited', taskId: 'thinking-task-1', at: TIME + 5 },
      ],
      createdAt: TIME, updatedAt: TIME + 10, history: [
        { at: TIME, event: 'issued', by: 'S:1', detail: 'A new badge was issued after an independent derivation.' },
        { at: TIME + 10, event: 'upheld', by: 'S:2', detail: `The second check found no missing domain restriction. [Review log](${REFERENCE_URLS.history})` },
      ] },
    { id: 'F:2', status: 'disputed', kind: 'result', claim: 'The solver converges for every positive step size.',
      conditions: 'Baseline implementation, seed 7.', method: 're-executed', evidence: 'Two independent runs disagree at step size 10.',
      reason: 'The conflicting results still require reconciliation.', createdAt: TIME, updatedAt: TIME + 20,
      history: [{ at: TIME + 20, event: 'disputed', detail: 'The shared evidence does not settle the disagreement.' }] },
    { id: 'F:3', status: 'revoked', kind: 'code', claim: 'The default iteration limit is 100.',
      conditions: 'Attached solver.py, line 12.', method: 'source-quoted', evidence: 'The current file says max_iterations = 200.',
      reason: 'The previous code excerpt was superseded.', supersededBy: 'F:5', createdAt: TIME, updatedAt: TIME + 30,
      uses: [{ agentId: 'legacy-reviewer', role: 'commentor', kind: 'recorded' }],
      history: [{ at: TIME + 30, event: 'revoked', by: 'F:5', detail: 'The corrected implementation supersedes this claim.' }] },
    { id: 'F:4', status: 'refuted', kind: 'math', claim: 'Every positive integer is prime.',
      conditions: 'Positive integers.', method: 'judgement-only', evidence: '4 = 2 × 2 is a counterexample.',
      reason: 'A concrete counterexample disproves the universal claim.', createdAt: TIME, updatedAt: TIME + 40,
      uses: [],
      history: [{ at: TIME + 40, event: 'refuted', by: 'S:4', detail: 'The counterexample is within the claimed domain.' }] },
  ];
}

async function fixture(page: Page, options: {
  factTable?: FactTableView;
  status?: JobDetail['status'];
  doneStatus?: DoneStage['status'];
} = {}) {
  const doneStatus = options.doneStatus ?? 'completed';
  const state = {
    detail: {
      ...makeJob(1, { jobId: 'fact-table-run', title: 'A review with recorded facts', status: options.status ?? 'completed' }),
      stages: [{ id: 'done', status: doneStatus,
        ...(doneStatus === 'completed' ? { summary: { agentTaskCount: 12, stageDurations: [] } } : {}),
        ...(options.factTable !== undefined ? { factTable: options.factTable } : {}),
      }],
    } as JobDetail,
    streamRequests: 0,
  };
  const brain = await mockBrain(page, { jobs: [state.detail] });
  await page.route(/\/api\/jobs\/fact-table-run(?:\/stream)?(?:\?|$)/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (new URL(route.request().url()).pathname.endsWith('/stream')) {
      state.streamRequests++;
      // Repeated complete snapshots must replace the view, never append rows.
      const event = `data: ${JSON.stringify({ type: 'job', job: state.detail })}\n\n`;
      return route.fulfill({ contentType: 'text/event-stream', body: event + event });
    }
    return route.fulfill({ json: state.detail });
  });
  await page.route('**/api/availability', route => route.fulfill({
    json: { version: 1, updatedAt: Date.now(), tools: [], purposes: [], demoteDegraded: false },
  }));
  await page.goto('/#/jobs/fact-table-run/stage/done');
  await expect(panel(page)).toBeVisible();
  return { state, brain };
}

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', error => messages.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page) ?? [], 'No uncaught browser errors').toEqual([]));

test('Done exposes the latest fact statuses and expandable complete proof, hash, rationale and history', async ({ page }, testInfo) => {
  const { brain } = await fixture(page, { factTable: { entries: facts() } });
  await expect(table(page).locator('tbody > tr')).toHaveCount(4);
  for (const status of ['Justified', 'Disputed', 'Revoked', 'Refuted']) {
    await expect(table(page).getByText(status, { exact: true })).toBeVisible();
  }
  await expect(table(page)).toContainText('Replaced by F:5');
  await expect(evidence(page)).toHaveCount(0);
  const show = panel(page).getByRole('button', { name: 'Show evidence for F:1', exact: true });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  const hide = panel(page).getByRole('button', { name: 'Hide evidence for F:1', exact: true });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await expect(evidence(page)).toContainText(PROOF);
  await expect(evidence(page).getByRole('link', { name: 'Proof notes', exact: true })).toBeVisible();
  await expect(panel(page).getByText(HASH, { exact: true })).toBeVisible();
  await expect(panel(page).locator('dt:has-text("Why this was recorded") + dd')).toContainText(REASON);
  await panel(page).locator('summary', { hasText: 'Verification history (2)' }).click();
  await expect(panel(page).getByRole('link', { name: 'Review log', exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('fact-table-desktop.png'), fullPage: true, animations: 'disabled' });
  await hide.click();
  await expect(evidence(page)).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Show evidence for F:2', exact: true }).click();
  await expect(panel(page).getByText('Not recorded for this badge.', { exact: true })).toBeVisible();
  expect(brain.unhandled).toEqual([]);
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

test('fact filters search evidence and status while download retains the complete recorded table', async ({ page }) => {
  const entries = facts();
  await fixture(page, { factTable: { entries } });
  await panel(page).getByLabel('Fact status', { exact: true }).selectOption('disputed');
  await expect(table(page).locator('tbody > tr')).toHaveCount(1);
  await expect(table(page)).toContainText('F:2');
  await panel(page).getByLabel('Search facts', { exact: true }).fill('counterexample');
  await expect(panel(page).getByText('No facts match these filters.', { exact: true })).toBeVisible();
  await panel(page).getByLabel('Fact status', { exact: true }).selectOption('all');
  await expect(table(page).locator('tbody > tr')).toHaveCount(1);
  await expect(table(page)).toContainText('F:4');
  const downloadPromise = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Download fact table', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fact-table.json');
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as FactTableView;
  expect(exported.entries).toEqual(entries);
  await panel(page).getByLabel('Search facts', { exact: true }).fill(HASH);
  await expect(table(page).locator('tbody > tr')).toHaveCount(1);
  await expect(table(page)).toContainText('F:1');
});

test('usage identifies agent, role, reviewed step and purpose, and remains searchable without invented missing details', async ({ page }) => {
  await fixture(page, { factTable: { entries: facts() } });
  await expect(table(page).getByRole('columnheader', { name: 'Used by / purpose', exact: true })).toBeVisible();
  const used = table(page).locator('tbody > tr').filter({ hasText: 'Geometry reviewer' });
  await expect(used).toHaveCount(1);
  await expect(used.getByText('Geometry reviewer', { exact: true })).toHaveAttribute('title', 'geometry-reviewer-2');
  await expect(used).toContainText('Critic · Step 2');
  await expect(used).toContainText('For Algebra thinker');
  await expect(used).toContainText('Submitted for verification');
  await expect(used).toContainText(PURPOSE);
  await expect(used).toContainText('Thinker · Step 1');
  await expect(used).toContainText('Establish the denominator before dividing.');
  const missing = table(page).locator('tbody > tr').filter({ hasText: 'The solver converges for every positive step size.' });
  await expect(missing.getByText('No usage recorded.', { exact: true })).toBeVisible();
  const legacy = table(page).locator('tbody > tr').filter({ hasText: 'The default iteration limit is 100.' });
  await expect(legacy).toContainText('legacy-reviewer');
  await expect(legacy).toContainText('Recorded interaction');
  await expect(legacy).toContainText('Step not recorded');
  await expect(legacy).toContainText('Purpose not recorded.');
  await expect(table(page).locator('tbody > tr').filter({ hasText: 'Every positive integer is prime.' })
    .getByText('No usage recorded.', { exact: true })).toBeVisible();
  for (const query of ['Geometry reviewer', 'geometry-reviewer-2', 'game-commentor', 'boundary inference', 'Step 2']) {
    await panel(page).getByLabel('Search facts', { exact: true }).fill(query);
    await expect(table(page).locator('tbody > tr')).toHaveCount(1);
    await expect(table(page)).toContainText('F:1');
  }
});

test('HTTP references are clickable across fact fields while punctuation, HTML and unsafe schemes stay safe', async ({ page }) => {
  const unsafe = '<img src=x onerror="window.__factEvidenceUnsafe=true"> [Unsafe command](javascript:alert(1)) [Inline document](data:text/html,unsafe)';
  const entries = facts();
  entries[0] = { ...entries[0]!, evidence: `${EVIDENCE}\n${unsafe}` };
  await page.context().route('https://research.example.test/**', route => route.fulfill({
    contentType: 'text/html', body: '<title>Reference fixture</title><p>Mock reference content.</p>',
  }));
  await fixture(page, { factTable: { entries } });
  await panel(page).getByRole('button', { name: 'Show evidence for F:1', exact: true }).click();
  await panel(page).locator('summary', { hasText: 'Verification history (2)' }).click();
  for (const [label, href] of [
    ['Bound statement', REFERENCE_URLS.claim], ['Domain', REFERENCE_URLS.conditions],
    ['Proof notes', REFERENCE_URLS.proof], [REFERENCE_URLS.bare, REFERENCE_URLS.bare],
    [REFERENCE_URLS.parentheses, REFERENCE_URLS.parentheses], ['Derivation notes', REFERENCE_URLS.reason],
    ['Review log', REFERENCE_URLS.history], ['Review plan', REFERENCE_URLS.purpose],
  ]) {
    const link = panel(page).getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('href', href!);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /(?:^|\s)noopener(?:\s|$)/);
    await expect(link).toHaveAttribute('rel', /(?:^|\s)noreferrer(?:\s|$)/);
  }
  await expect(evidence(page)).toContainText(unsafe);
  await expect(panel(page).locator('img, script, iframe')).toHaveCount(0);
  await expect(panel(page).locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
  expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(window, '__factEvidenceUnsafe'))).toBe(false);
  const popupPromise = page.waitForEvent('popup');
  await evidence(page).getByRole('link', { name: 'Proof notes', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(REFERENCE_URLS.proof);
  await popup.close();
});

test('interrupted runs expose recorded facts even when Done has not completed', async ({ page }) => {
  const { brain } = await fixture(page, { factTable: { entries: facts() }, status: 'orphaned', doneStatus: 'pending' });
  await expect(table(page)).toBeVisible();
  await expect(table(page).locator('tbody > tr')).toHaveCount(4);
  await panel(page).getByRole('button', { name: 'Show evidence for F:1', exact: true }).click();
  await expect(evidence(page)).toContainText(PROOF);
  expect(brain.unhandled).toEqual([]);
});

test('new and repeated SSE snapshots replace a badge without stale or duplicate rows', async ({ page }) => {
  const entries = facts();
  const { state } = await fixture(page, { factTable: { entries } });
  await expect(table(page).locator('tbody > tr')).toHaveCount(4);
  const updated: FactEntryView = { ...entries[0]!, claim: 'The denominator bound holds only for finite real inputs.',
    status: 'disputed', updatedAt: TIME + 100,
    history: [...entries[0]!.history, { at: TIME + 100, event: 'disputed', detail: 'A newly supplied domain needs checking.' }] };
  state.detail = { ...state.detail, updatedAt: state.detail.updatedAt + 100,
    stages: [{ id: 'done', status: 'completed', factTable: { entries: [updated, ...entries.slice(1)] } }] };
  await expect(table(page).getByText(updated.claim, { exact: true })).toBeVisible();
  await expect(table(page)).not.toContainText(CLAIM);
  await expect(table(page).locator('tbody > tr')).toHaveCount(4);
  await expect(panel(page).getByRole('button', { name: 'Show evidence for F:1', exact: true })).toHaveCount(1);
  await page.reload();
  await expect(table(page).getByText(updated.claim, { exact: true })).toBeVisible();
  await expect(table(page).locator('tbody > tr')).toHaveCount(4);
});

for (const scenario of [
  { name: 'missing journal', table: undefined, message: 'No fact table was recorded for this run.' },
  { name: 'empty journal', table: { entries: [] }, message: 'No facts have been recorded yet.' },
] satisfies { name: string; table: FactTableView | undefined; message: string }[]) {
  test(`Done distinguishes ${scenario.name} from a populated fact table`, async ({ page }) => {
    await fixture(page, { factTable: scenario.table });
    await expect(panel(page).getByText(scenario.message, { exact: true })).toBeVisible();
    await expect(table(page)).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Download fact table', exact: true })).toHaveCount(0);
  });
}

test('a fact-journal read error remains visible alongside the last recorded facts', async ({ page }) => {
  const message = 'The fact journal could not be read. Showing the last recorded facts.';
  await fixture(page, { factTable: { entries: facts(), error: message } });
  await expect(panel(page).getByRole('status').filter({ hasText: message })).toBeVisible();
  await expect(table(page).locator('tbody > tr')).toHaveCount(4);
  await expect(panel(page).getByText('No facts have been recorded yet.', { exact: true })).toHaveCount(0);
});

test('full evidence and hashes stay within an internally scrolling table on a narrow screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page, { factTable: { entries: facts() } });
  await panel(page).getByRole('button', { name: 'Show evidence for F:1', exact: true }).click();
  await expect(evidence(page)).toContainText(PROOF);
  await expect(evidence(page).getByRole('link', { name: 'Proof notes', exact: true })).toBeVisible();
  await expect(panel(page).getByText(HASH, { exact: true })).toBeVisible();
  const scroll = panel(page).getByRole('region', { name: 'Fact table entries', exact: true });
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const bounds = (await panel(page).boundingBox())!;
    return bounds.x + bounds.width;
  }).toBeLessThanOrEqual(391);
  await scroll.evaluate(element => { element.scrollLeft = 0; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('fact-table-narrow.png'), fullPage: true, animations: 'disabled' });
  await table(page).getByText('Geometry reviewer', { exact: true }).scrollIntoViewIfNeeded();
  await expect(table(page).getByRole('link', { name: 'Review plan', exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('fact-table-narrow-usage.png'), fullPage: true, animations: 'disabled' });
});

test('Done lists deleted badges with their replacements and reconsiderations, never their claims', async ({ page }) => {
  const entries = facts().filter(fact => fact.status === 'justified' || fact.status === 'disputed');
  const factTable: FactTableView = {
    entries,
    deleted: [{ id: 'F:6', at: TIME + 50, replacedBy: 'F:1' }, { id: 'F:7', at: TIME + 60 }],
    updates: [
      { notice: 'N:1', deleted: 'F:6', replacedBy: 'F:1', at: TIME + 51, subscribers: [
        { key: 'chain:member-2', kind: 'chain', agentId: 'member-2', seatId: 'member-2', state: 'applied' },
        { key: 'game-report:member-2:3:1:member-4', kind: 'game-report', agentId: 'member-4', seatId: 'member-2', step: 3, round: 1, state: 'running' },
        { key: 'comment:member-2:3:1:member-4', kind: 'comment', agentId: 'member-4', seatId: 'member-2', step: 3, round: 1, state: 'withdrawn' },
        { key: 'none:supreme_judge:supreme_judge', kind: 'none', agentId: 'supreme_judge', state: 'no-task' },
      ] },
      { notice: 'N:2', deleted: 'F:7', at: TIME + 61, subscribers: [
        { key: 'chain:member-3', kind: 'chain', agentId: 'member-3', seatId: 'member-3', state: 'unchanged' },
        { key: 'game-report:member-3:1:2:member-1', kind: 'game-report', agentId: 'member-1', seatId: 'member-3', step: 1, round: 2, state: 'failed' },
        { key: 'comment:member-3:1:2:member-2', kind: 'comment', agentId: 'member-2', seatId: 'member-3', step: 1, round: 2, state: 'discarded' },
      ] },
    ],
  };
  const { brain } = await fixture(page, { factTable });
  const deleted = panel(page).getByRole('region', { name: 'Deleted badges', exact: true });
  await expect(deleted.getByRole('heading', { name: 'Deleted badges', exact: true })).toBeVisible();
  await expect(deleted.getByText('Badges the supreme judge deleted after a later check showed them wrong. Their claims are not kept.', { exact: true })).toBeVisible();
  const list = deleted.getByRole('table', { name: 'Deleted badges', exact: true });
  for (const column of ['Badge', 'Deleted at', 'Replaced by', 'Reconsiderations']) {
    await expect(list.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
  }
  await expect(list.locator('tbody > tr')).toHaveCount(2);
  const first = list.locator('tbody > tr').filter({ has: page.getByRole('rowheader', { name: 'F:6', exact: true }) });
  await expect(first.getByRole('cell').nth(1)).toHaveText('F:1');
  for (const [label, state] of [
    ['Chain of member-2', 'Revised'], ['Report by member-4 on member-2, step 3, round 1', 'Running'],
    ['Comment by member-4 on member-2, step 3, round 1', 'Withdrawn'], ['supreme_judge', 'No revisable output'],
  ] as const) {
    await expect(first.locator('li').filter({ has: page.getByText(label, { exact: true }) })).toContainText(state);
  }
  const second = list.locator('tbody > tr').filter({ has: page.getByRole('rowheader', { name: 'F:7', exact: true }) });
  await expect(second.getByRole('cell').nth(1)).toHaveText('');
  for (const [label, state] of [
    ['Chain of member-3', 'Unchanged'], ['Report by member-1 on member-3, step 1, round 2', 'Failed'],
    ['Comment by member-2 on member-3, step 1, round 2', 'Discarded'],
  ] as const) {
    await expect(second.locator('li').filter({ has: page.getByText(label, { exact: true }) })).toContainText(state);
  }
  // The recorded facts are unchanged by the list beside them.
  await expect(table(page).locator('tbody > tr')).toHaveCount(entries.length);
  await expect(panel(page).getByText(`${entries.length} of ${entries.length} facts`, { exact: true })).toBeVisible();
  expect(brain.unhandled).toEqual([]);
});

test('Done shows no deleted-badge list when no badge was deleted', async ({ page }) => {
  await fixture(page, { factTable: { entries: facts(), deleted: [], updates: [] } });
  await expect(table(page).locator('tbody > tr')).toHaveCount(4);
  await expect(panel(page).getByRole('region', { name: 'Deleted badges', exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('table', { name: 'Deleted badges', exact: true })).toHaveCount(0);
});

for (const scenario of [
  { name: 'every recorded badge was deleted', table: { entries: [], deleted: [{ id: 'F:6', at: TIME + 50, replacedBy: 'F:7' }, { id: 'F:7', at: TIME + 60 }] },
    message: 'No badges remain in the fact table.', other: 'No facts have been recorded yet.' },
  { name: 'nothing was recorded or deleted', table: { entries: [], deleted: [] },
    message: 'No facts have been recorded yet.', other: 'No badges remain in the fact table.' },
] satisfies { name: string; table: FactTableView; message: string; other: string }[]) {
  test(`an empty fact table says which empty state it is when ${scenario.name}`, async ({ page }) => {
    await fixture(page, { factTable: scenario.table });
    await expect(panel(page).getByText(scenario.message, { exact: true })).toBeVisible();
    await expect(panel(page).getByText(scenario.other, { exact: true })).toHaveCount(0);
    await expect(panel(page).getByText('No fact table was recorded for this run.', { exact: true })).toHaveCount(0);
    await expect(table(page)).toHaveCount(0);
    await expect(panel(page).getByRole('table', { name: 'Deleted badges', exact: true }).locator('tbody > tr')).toHaveCount(scenario.table.deleted?.length ?? 0);
  });
}
