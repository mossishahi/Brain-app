import { expect, test, type Page } from '@playwright/test';
import type { JobDetail, StageId, StageStatus, StageView } from '@brainstorm-agentic/protocol';
import { makeJob, mockBrain } from './fixtures';

const stageOrder = [
  ['process-input', 'Process', 'Process input'],
  ['decompose-experts', 'Decompose', 'Decompose'],
  ['select-panel', 'Panel', 'Panel selection'],
  ['confirm-panel', 'Confirm', 'Confirm panel'],
  ['first-pass', 'First pass', 'First pass'],
  ['review-members', 'Review', 'Review'],
  ['bridge-audit', 'Audit', 'Integration audit'],
  ['synthesize-proposal', 'Proposal', 'Proposal'],
  ['done', 'Done', 'Done'],
] as const;

const library = (page: Page) => page.getByRole('complementary', { name: 'Research library', exact: true });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });
const back = (page: Page) => page.locator('[data-dashboard-back]');

async function expectStage(page: Page, stageId: StageId) {
  const entry = stageOrder.find(([id]) => id === stageId)!;
  await expect(page.getByRole('group', { name: 'pipeline stages', exact: true })
    .getByRole('button', { name: new RegExp(`^${entry[1]} stage: .*selected$`) })).toBeVisible();
  await expect(library(page)).not.toBeVisible();
  await expect(page.locator('#sidebar-history-trigger')).toHaveAttribute('aria-expanded', 'false');
}

async function fixture(page: Page, activeStage: StageId = 'review-members') {
  const activeIndex = stageOrder.findIndex(([id]) => id === activeStage);
  const stages: StageView[] = stageOrder.map(([id], index): StageView => {
    const status: StageStatus = index < activeIndex ? 'completed' : index === activeIndex ? 'active' : 'pending';
    if (id === 'confirm-panel') return { id, status, gate: { state: index < activeIndex ? 'approved' : 'not-reached' } };
    if (id === 'first-pass') return { id, status, members: [] };
    if (id === 'review-members') return { id, status, members: [], maxRounds: 4 };
    return { id, status };
  });
  const detail: JobDetail = {
    ...makeJob(1, { jobId: 'navigation-run', title: 'A hypothesis across pipeline stages', status: 'running' }),
    stages,
  };
  const brain = await mockBrain(page, { jobs: [detail] });
  await page.route(/\/api\/jobs\/navigation-run(?:\/stream)?(?:\?|$)/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return new URL(route.request().url()).pathname.endsWith('/stream')
      ? route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'job', job: detail })}\n\n` })
      : route.fulfill({ json: detail });
  });
  await page.route('**/api/availability', route => route.fulfill({
    json: { version: 1, updatedAt: Date.now(), tools: [], purposes: [], demoteDegraded: false },
  }));
  return brain;
}

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', error => messages.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page) ?? [], 'No uncaught browser errors').toEqual([]));

test('heading back follows the previous pipeline stage and survives reload and browser history', async ({ page }) => {
  const brain = await fixture(page);
  await page.goto('/#/jobs/navigation-run/stage/review-members');
  await expectStage(page, 'review-members');
  await expect(back(page)).toHaveAccessibleName('Back to First pass');
  await back(page).click();
  await expect(page).toHaveURL(/#\/jobs\/navigation-run\/stage\/first-pass$/);
  await expectStage(page, 'first-pass');
  await expect(page.locator('.dash-title')).toHaveText('A hypothesis across pipeline stages');
  await page.reload();
  await expectStage(page, 'first-pass');
  await expect(back(page)).toHaveAccessibleName('Back to Confirm panel');
  await page.goBack();
  await expectStage(page, 'review-members');
  await expect(back(page)).toHaveAccessibleName('Back to First pass');
  await page.goForward();
  await expectStage(page, 'first-pass');
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('repeated heading back visits preceding stages and then home without opening search', async ({ page }) => {
  const brain = await fixture(page);
  await page.goto('/#/jobs/navigation-run/stage/done');
  await expectStage(page, 'done');
  for (let index = stageOrder.length - 2; index >= 0; index--) {
    const [id, , title] = stageOrder[index]!;
    await expect(back(page)).toHaveAccessibleName(`Back to ${title}`);
    await back(page).click();
    await expect(page).toHaveURL(new RegExp(`#/jobs/navigation-run/stage/${id}$`));
    await expectStage(page, id);
  }
  await expect(back(page)).toHaveAccessibleName('Back to home');
  await back(page).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/$/);
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page)).toBeFocused();
  await expect(library(page)).not.toBeVisible();
  await expect(page.locator('.dash')).toHaveCount(0);
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

test('a run URL without a stage navigates back from its current active stage', async ({ page }) => {
  await fixture(page);
  await page.goto('/#/jobs/navigation-run');
  await expectStage(page, 'review-members');
  await expect(back(page)).toHaveAccessibleName('Back to First pass');
  await back(page).click();
  await expectStage(page, 'first-pass');
  await expect(page).toHaveURL(/#\/jobs\/navigation-run\/stage\/first-pass$/);
});

test('heading back follows a stage selected from the pipeline graph rather than the original deep link', async ({ page }) => {
  await fixture(page);
  await page.goto('/#/jobs/navigation-run/stage/review-members');
  await expectStage(page, 'review-members');
  await page.getByRole('group', { name: 'pipeline stages', exact: true })
    .getByRole('button', { name: /^Audit stage:/ }).click();
  await expectStage(page, 'bridge-audit');
  await expect(page).toHaveURL(/#\/jobs\/navigation-run\/stage\/bridge-audit$/);
  await expect(back(page)).toHaveAccessibleName('Back to Review');
  await back(page).click();
  await expectStage(page, 'review-members');
  await expect(page).toHaveURL(/#\/jobs\/navigation-run\/stage\/review-members$/);
});

test('back from the first stage returns to the existing home draft with the library closed', async ({ page }) => {
  const brain = await fixture(page, 'process-input');
  await page.goto('/');
  await prompt(page).fill('Keep this unfinished hypothesis for later.');
  await page.locator('#sidebar-history-trigger').click();
  await library(page).getByRole('link', { name: 'Open research: A hypothesis across pipeline stages', exact: true }).click();
  await expectStage(page, 'process-input');
  await expect(back(page)).toHaveAccessibleName('Back to home');
  await back(page).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(prompt(page)).toHaveValue('Keep this unfinished hypothesis for later.');
  await expect(prompt(page)).toBeFocused();
  await expect(library(page)).not.toBeVisible();
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});
