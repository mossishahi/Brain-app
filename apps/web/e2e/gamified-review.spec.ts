import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { FirstPassMemberView, JobDetail, ReviewMemberView } from '@brainstorm-agentic/protocol';
import { defaultTestSettings, makeJob, mockBrain } from './fixtures';

async function openResearchSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Research', exact: true }).click();
  return dialog;
}

async function mockResearchReadiness(page: Page) {
  await page.route('**/api/panel-composition', route => route.fulfill({ json: { groups: [], params: [], coreKeyConfigured: false } }));
  await page.route('**/api/readiness/encoders', route => route.fulfill({ json: { encoders: [] } }));
  await page.route('**/api/availability', route => route.fulfill({ json: { version: 1, updatedAt: Date.now(), tools: [], purposes: [], demoteDegraded: false } }));
}

test('gamified review defaults off and persists independently of the review budget', async ({ page }) => {
  const brain = await mockBrain(page);
  await mockResearchReadiness(page);
  await page.goto('/');
  let dialog = await openResearchSettings(page);
  const toggle = () => dialog.getByRole('switch', { name: 'Gamified review', exact: true });
  const rule = () => dialog.getByLabel('Decision rule', { exact: true });
  const leaveOneOut = () => dialog.getByRole('switch', { name: 'Leave-one-out scoring', exact: true });
  await expect(toggle()).not.toBeChecked();
  await expect(rule()).toBeDisabled();
  await expect(leaveOneOut()).toBeDisabled();
  await toggle().click();
  await expect.poll(() => brain.settings.gamifiedReview).toBe(true);
  // Spec defaults: chair-decisive, under which leave-one-out does not apply.
  await expect(rule()).toBeEnabled();
  await expect(rule()).toHaveValue('chair-decisive');
  await expect(leaveOneOut()).toBeChecked();
  await expect(leaveOneOut()).toBeDisabled();
  await expect(leaveOneOut()).toContainText("not applicable: the chair label does not depend on the critics' numbers");
  await rule().selectOption('committee-mean');
  await expect.poll(() => brain.settings.gameReview).toEqual({ threshold: 0.5, decisionRule: 'committee-mean', leaveOneOut: true });
  await expect(leaveOneOut()).toBeEnabled();
  await expect(leaveOneOut()).not.toContainText('not applicable');
  await leaveOneOut().click();
  await expect.poll(() => brain.settings.gameReview).toEqual({ threshold: 0.5, decisionRule: 'committee-mean', leaveOneOut: false });
  await dialog.getByLabel('Game decision threshold', { exact: true }).fill('0.3');
  await dialog.getByLabel('Reviewer starting points', { exact: true }).selectOption('custom');
  await dialog.getByLabel('Starting points per reviewer', { exact: true }).fill('0');
  await dialog.getByLabel('Starting points per reviewer', { exact: true }).blur();
  await expect.poll(() => brain.settings.gameReview).toEqual({ threshold: 0.3, initialPoints: 0, decisionRule: 'committee-mean', leaveOneOut: false });
  await dialog.getByLabel('Rounds one chain step may take', { exact: true }).selectOption('2');
  await expect.poll(() => brain.settings.review?.maxRounds).toBe(2);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  dialog = await openResearchSettings(page);
  await expect(toggle()).toBeChecked();
  await expect(dialog.getByLabel('Game decision threshold', { exact: true })).toHaveValue('0.3');
  await expect(dialog.getByLabel('Starting points per reviewer', { exact: true })).toHaveValue('0');
  await expect(rule()).toHaveValue('committee-mean');
  await expect(leaveOneOut()).toBeEnabled();
  await expect(leaveOneOut()).not.toBeChecked();
  await expect(dialog.getByLabel('Rounds one chain step may take', { exact: true })).toHaveValue('2');
  await toggle().click();
  await expect.poll(() => brain.settings.gamifiedReview).toBe(false);
  await expect(rule()).toBeDisabled();
  await expect(leaveOneOut()).toBeDisabled();
  expect(brain.settings.review?.maxRounds).toBe(2);
  expect(brain.settings.gameReview).toEqual({ threshold: 0.3, initialPoints: 0, decisionRule: 'committee-mean', leaveOneOut: false });
  await toggle().click();
  await dialog.getByLabel('Reviewer starting points', { exact: true }).selectOption('auto');
  await expect.poll(() => brain.settings.gameReview).toEqual({ threshold: 0.3, decisionRule: 'committee-mean', leaveOneOut: false });
  // Switching back to the chair rule keeps the stored leave-one-out value but greys the toggle again.
  await rule().selectOption('chair-decisive');
  await expect.poll(() => brain.settings.gameReview).toEqual({ threshold: 0.3, decisionRule: 'chair-decisive', leaveOneOut: false });
  await expect(leaveOneOut()).toBeDisabled();
  await expect(leaveOneOut()).toContainText('not applicable');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  expect(brain.unhandled).toEqual([]);
});

test('the quick Research controls carry the decision rule and grey leave-one-out under the chair rule', async ({ page }) => {
  const brain = await mockBrain(page, { settings: { ...defaultTestSettings(), gamifiedReview: true, gameReview: { threshold: 0.5, decisionRule: 'chair-decisive', leaveOneOut: true } } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Research', exact: true }).click();
  const leaveOneOut = () => page.getByRole('menuitemcheckbox', { name: 'Leave-one-out scoring', exact: true });
  await expect(leaveOneOut()).toBeChecked();
  await expect(leaveOneOut()).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Decision rule', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Committee mean', exact: true }).click();
  await expect.poll(() => brain.settings.gameReview).toEqual({ threshold: 0.5, decisionRule: 'committee-mean', leaveOneOut: true });
  await page.keyboard.press('Escape');
  await expect(leaveOneOut()).toBeEnabled();
  await leaveOneOut().click();
  await expect.poll(() => brain.settings.gameReview).toEqual({ threshold: 0.5, decisionRule: 'committee-mean', leaveOneOut: false });
  await expect(leaveOneOut()).not.toBeChecked();
  expect(brain.unhandled).toEqual([]);
});

function gameJob(scoringV3 = false): JobDetail {
  const first: FirstPassMemberView[] = ['a', 'b', 'c'].map((id, index) => ({
    memberId: id, label: `Seat ${index + 1}`, department: 'Mathematics', umbrella: 'Proof review',
    subfields: [], status: 'completed', idea: { type: 'explanation', shape: 'explanation', cot: ['A boundary assumption.', 'The conclusion.'] },
  }));
  const members: ReviewMemberView[] = first.map((member, index) => ({
    memberId: member.memberId, label: member.label, department: member.department, umbrella: member.umbrella,
    steps: index === 0 ? [
      { index: 1, outcome: 'unresolved', rounds: [{
        round: 1, cot: 'A boundary assumption.', comments: [],
        gameCritiques: [
          { criticId: 'b', criticLabel: 'Seat 2', q: 0.5, justification: 'The boundary assumption excludes a valid input.' },
          { criticId: 'c', criticLabel: 'Seat 3', q: 0.1, justification: 'This report discusses an unrelated task.' },
        ],
        gameChair: { reports: { b: { admissible: true, reason: 'A relevant supported counterexample.', ...(scoringV3 ? { label: 'decisive' as const } : {}), factChecks: [{ factId: 'F:1', conditions: 'All valid inputs', supportsConclusion: true, reason: 'The input lies within the stated domain.' }] }, c: { admissible: false, reason: 'Unrelated to the current reasoning.', ...(scoringV3 ? { label: 'invalid' as const } : {}), factChecks: [] } }, reason: 'The reports were checked against the current reasoning and fact conditions.', issues: [] },
        gameSettlement: { ruleVersion: scoringV3 ? 'brier-peer/v3' : 'brier-peer/v2', version: 'chain-fixture-1', y: 1, meanQ: 0.5, threshold: 0.5, initialPoints: 300, ledgerSequence: 1, settlementId: 'fixture/1', criticIds: ['a', 'b', 'c'], status: 'settled', admittedCount: 1, ...(scoringV3 ? { decisionRule: 'chair-decisive' as const, leaveOneOut: true } : {}), rows: [
          { criticId: 'b', q: 0.5, admissible: true, reason: 'A relevant supported counterexample.', brierLoss: 0.25, baseScore: 0, peerMeanBaseScore: null, score: 0, balanceBefore: 300, balanceAfter: 300, excluded: false, ...(scoringV3 ? { label: 'decisive' as const, scoringLabel: 1 as const } : {}) },
          { criticId: 'c', q: 0.1, admissible: false, reason: 'Unrelated to the current reasoning.', brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceBefore: 300, balanceAfter: 300, excluded: false, ...(scoringV3 ? { label: null, scoringLabel: null } : {}) },
        ] },
        decision: { verdict: 'Interrupt', reason: 'The boundary assumption needs repair.', assessment: {} },
      }] },
      { index: 2, outcome: 'under-review', rounds: [{ round: 1, cot: 'The conclusion.', comments: [], gameCritiques: [{ criticId: 'b', criticLabel: 'Seat 2', q: 0.2, justification: 'The conclusion needs a final check.' }] }] },
    ] : [],
  }));
  return {
    ...makeJob(1, { jobId: 'game-fixture', title: 'A gamified review', status: 'running', gamifiedReview: true }),
    stages: [
      { id: 'first-pass', status: 'completed', members: first },
      { id: 'review-members', status: 'active', maxRounds: 1, gamifiedReview: true, gameReview: { threshold: 0.5, ...(scoringV3 ? { decisionRule: 'chair-decisive' as const, leaveOneOut: true } : {}) }, gameLedger: { initialPoints: 300, ledgerSequence: 1, critics: ['a', 'b', 'c'].map(criticId => ({ criticId, balance: 300, excluded: false, eligible: true })) }, members },
    ],
  };
}

test('recorded game mode shows chair, probabilities, scored zero, rejected and pending reports, and exports them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const detail = gameJob();
  // The server preference is off: the run's saved mode still controls display.
  const brain = await mockBrain(page, { jobs: [detail] });
  await mockResearchReadiness(page);
  await page.route(/\/api\/jobs\/game-fixture(?:\/stream)?(?:\?|$)/, route => {
    if (new URL(route.request().url()).pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'job', job: detail })}\n\n` });
    return route.fulfill({ json: detail });
  });
  await page.goto('/#/jobs/game-fixture/stage/review-members');
  const board = page.getByRole('region', { name: 'Gamified review scores', exact: true });
  await expect(board).toBeVisible();
  await expect(board.locator('tbody tr').filter({ hasText: 'Seat 2' }).locator('td')).toHaveText(['1', '0', '1', '1', '0.000', '300.000', 'Eligible']);
  await expect(board.locator('tbody tr').filter({ hasText: 'Seat 3' }).locator('td')).toHaveText(['0', '1', '0', '0', 'unscored', '300.000', 'Eligible']);
  await expect(board).toContainText('Starting points per reviewer: 300');
  const firstStep = page.locator('.review-card').nth(0);
  await firstStep.getByRole('tab', { name: 'Committee chair', exact: true }).click();
  await expect(firstStep.getByText('Committee decision: major flaw identified (y=1)', { exact: true })).toBeVisible();
  await expect(firstStep).toContainText('Mean admitted q: 0.5; threshold: 0.5; mean >= threshold');
  await expect(firstStep).toContainText('The reports were checked against the current reasoning and fact conditions.');
  await expect(firstStep).toContainText('Conditions: All valid inputs');
  await firstStep.getByRole('tab', { name: 'Seat 2 · q=0.5', exact: true }).click();
  await expect(firstStep).toContainText('Probability of a major flaw that could prevent a correct final solution');
  await expect(firstStep).toContainText('The boundary assumption excludes a valid input.');
  await expect(firstStep).toContainText('Base S: 0.000');
  await expect(firstStep).toContainText('Final R: 0.000');
  await expect(firstStep).toContainText('Balance: 300.000 → 300.000');
  await firstStep.getByRole('tab', { name: 'Seat 3 · q=0.1', exact: true }).click();
  await expect(firstStep).toContainText('Rejected: Unrelated to the current reasoning.');
  await expect(firstStep).toContainText('Final R: unscored');
  const secondStep = page.locator('.review-card').nth(1);
  await secondStep.getByRole('tab', { name: 'Seat 2 · q=0.2', exact: true }).click();
  await expect(secondStep).toContainText('Admissibility pending');
  await expect(secondStep).toContainText('Scores pending');
  const history = board.locator('details').filter({ has: page.locator('summary', { hasText: 'Seat 2 · own feedback history' }) });
  await history.locator('summary').click();
  await expect(history).toContainText('The boundary assumption excludes a valid input.');
  await expect(history).not.toContainText('This report discusses an unrelated task.');
  const downloadPromise = page.waitForEvent('download');
  await board.getByRole('button', { name: 'Export scores and reports', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('review-scores.txt');
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain('q is the probability of a major flaw');
  expect(text).toContain('b: q=0.5; admissible; loss=0.25; base S=0; peer mean=unscored; final R=0');
  expect(text).toContain('c: q=0.1; rejected');
  expect(text).toContain('Scores pending');
  expect(text).toContain('Mean admitted q: 0.5; threshold: 0.5');
  expect(text).toContain('balance after=300');
  expect(text).toContain('Seat 2: own feedback history');
  expect(errors).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('a scoring v3 run shows the decision rule, chair labels and the scoring label beside each score', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const detail = gameJob(true);
  const brain = await mockBrain(page, { jobs: [detail] });
  await mockResearchReadiness(page);
  await page.route(/\/api\/jobs\/game-fixture(?:\/stream)?(?:\?|$)/, route => {
    if (new URL(route.request().url()).pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'job', job: detail })}\n\n` });
    return route.fulfill({ json: detail });
  });
  await page.goto('/#/jobs/game-fixture/stage/review-members');
  const board = page.getByRole('region', { name: 'Gamified review scores', exact: true });
  await expect(board).toContainText('Decision rule: chair decisive: any admitted decisive argument blocks');
  await expect(board).toContainText('The mean admitted q is recorded but the chair label decides.');
  const firstStep = page.locator('.review-card').nth(0);
  await firstStep.getByRole('tab', { name: 'Committee chair', exact: true }).click();
  await expect(firstStep.getByText('Committee decision: major flaw identified (y=1)', { exact: true })).toBeVisible();
  await expect(firstStep).toContainText('An admitted argument is decisive → major flaw identified (y=1). Rule: chair decisive');
  await expect(firstStep).toContainText('Mean admitted q: 0.5 (recorded; decides nothing)');
  await expect(firstStep).toContainText('Seat 2 — admissible · decisive:');
  await expect(firstStep).toContainText('Seat 3 — rejected · no chair label:');
  await expect(firstStep).toContainText('rule: chair decisive');
  await firstStep.getByRole('tab', { name: 'Seat 2 · q=0.5', exact: true }).click();
  await expect(firstStep).toContainText('Chair label: decisive · Scored against: y=1');
  await expect(firstStep).toContainText('Final R: 0.000');
  await firstStep.getByRole('tab', { name: 'Seat 3 · q=0.1', exact: true }).click();
  await expect(firstStep).toContainText('Chair label: no chair label · Scored against: unscored');
  const downloadPromise = page.waitForEvent('download');
  await board.getByRole('button', { name: 'Export scores and reports', exact: true }).click();
  const text = await readFile((await (await downloadPromise).path())!, 'utf8');
  expect(text).toContain('Gamified review: the committee chair labels each admitted argument');
  expect(text).toContain('b: q=0.5; admissible; loss=0.25; base S=0; peer mean=unscored; final R=0; A relevant supported counterexample.; balance before=300; balance after=300; eligible for future critic work; chair label=decisive; scored against=y=1');
  expect(text).toContain('c: q=0.1; rejected');
  expect(text).toContain('chair label=no chair label; scored against=unscored');
  expect(errors).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('an invented-badge penalty row shows the cited badge and the floor score in the report, the feedback history and the export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = JSON.parse(JSON.stringify(gameJob(true)));
  const settlement = fixture.stages[1].members[0].steps[0].rounds[0].gameSettlement;
  settlement.inventedBadgePenalty = true;
  Object.assign(settlement.rows[1], { score: -175, balanceAfter: 125, penalty: 'invented-badge', inventedBadges: ['F:7'],
    reason: "Unrelated to the current reasoning. Host verification: invented badge F:7 never issued in this run's fact table; penalty -175." });
  fixture.stages[1].gameLedger.critics[2].balance = 125;
  const detail: JobDetail = fixture;
  const brain = await mockBrain(page, { jobs: [detail] });
  await mockResearchReadiness(page);
  await page.route(/\/api\/jobs\/game-fixture(?:\/stream)?(?:\?|$)/, route => {
    if (new URL(route.request().url()).pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'job', job: detail })}\n\n` });
    return route.fulfill({ json: detail });
  });
  await page.goto('/#/jobs/game-fixture/stage/review-members');
  const board = page.getByRole('region', { name: 'Gamified review scores', exact: true });
  await expect(board).toBeVisible();
  await expect(board.locator('tbody tr').filter({ hasText: 'Seat 3' }).locator('td')).toHaveText(['0', '1', '0', '0', '-175.000', '125.000', 'Eligible']);
  await expect(board).toContainText("the reviewer's own solution continues. Rejected reports are unscored, except that a report citing a badge never issued in this run's fact table records -175. This is an internal review signal.");
  const firstStep = page.locator('.review-card').nth(0);
  await firstStep.getByRole('tab', { name: 'Seat 3 · q=0.1', exact: true }).click();
  await expect(firstStep).toContainText('Invented badge [F:7]: -175.000');
  await expect(firstStep).toContainText('Final R: -175.000');
  await expect(firstStep).toContainText('Balance: 300.000 → 125.000');
  const history = board.locator('details').filter({ has: page.locator('summary', { hasText: 'Seat 3 · own feedback history' }) });
  await history.locator('summary').click();
  await expect(history).toContainText('Invented badge [F:7]: -175.000');
  const downloadPromise = page.waitForEvent('download');
  await board.getByRole('button', { name: 'Export scores and reports', exact: true }).click();
  const text = await readFile((await (await downloadPromise).path())!, 'utf8');
  expect(text).toContain('chair label=no chair label; scored against=unscored; Invented badge [F:7]: -175.000');
  expect(text).toContain("one admitted report: R = S. Rejected reports are unscored, except that a report citing a badge never issued in this run's fact table records -175.");
  expect(text).toContain('Seat 3 (c): admitted=0; rejected=1; pending=0; scored=0; total R=-175; balance=125');
  expect(errors).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('without the invented-badge flag the scoreboard keeps the original rejection sentence', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const detail = gameJob(true);
  const brain = await mockBrain(page, { jobs: [detail] });
  await mockResearchReadiness(page);
  await page.route(/\/api\/jobs\/game-fixture(?:\/stream)?(?:\?|$)/, route => {
    if (new URL(route.request().url()).pathname.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'job', job: detail })}\n\n` });
    return route.fulfill({ json: detail });
  });
  await page.goto('/#/jobs/game-fixture/stage/review-members');
  const board = page.getByRole('region', { name: 'Gamified review scores', exact: true });
  await expect(board).toContainText("the reviewer's own solution continues. Rejected reports are unscored. This is an internal review signal.");
  await expect(board).not.toContainText('except that a report citing a badge');
  await expect(board.locator('tbody tr').filter({ hasText: 'Seat 3' }).locator('td')).toHaveText(['0', '1', '0', '0', 'unscored', '300.000', 'Eligible']);
  const downloadPromise = page.waitForEvent('download');
  await board.getByRole('button', { name: 'Export scores and reports', exact: true }).click();
  const text = await readFile((await (await downloadPromise).path())!, 'utf8');
  expect(text).toContain("one admitted report: R = S. Rejected reports are unscored.");
  expect(text).not.toContain('except that a report citing a badge');
  expect(errors).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});
