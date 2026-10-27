import { expect, test, type Page } from '@playwright/test';
import { gpuDraftFixture, mockBrain } from './fixtures';

const gpuDialog = (page: Page) => page.getByRole('dialog', { name: 'GPU execution', exact: true });
async function openGpu(page: Page) { await page.getByRole('button', { name: /^GPU setup:/ }).click(); return gpuDialog(page); }

test('discovery progress is server-owned; showing its draft submits no job', async ({ page }) => {
  const brain = await mockBrain(page);
  brain.gpuSetup = { ...gpuDraftFixture(), draft: undefined, phase: 'discovering', progress: { percent: 35, message: 'Inspecting GPU partitions' } };
  await page.goto('/');
  const dialog = await openGpu(page);
  await expect(dialog.getByRole('progressbar', { name: 'GPU setup progress' })).toHaveAttribute('value', '35');
  brain.gpuSetup = gpuDraftFixture();
  await expect(dialog.getByRole('button', { name: 'Approve and run probe' })).toBeVisible();
  expect(brain.writes.filter(write => write.path.startsWith('/gpu/'))).toEqual([]);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: /^GPU setup: Pending approval/ })).toBeFocused();
  expect(brain.unhandled).toEqual([]);
});

test('polling distinguishes submission, observed queue wait, result collection and verified readiness', async ({ page }) => {
  const brain = await mockBrain(page);
  const startedAt = new Date().toISOString();
  brain.gpuSetup = { ...gpuDraftFixture(), phase: 'probing', progress: { percent: 20, message: 'Probe accepted by SLURM; checking status' }, probe: { jobId: '12345', state: 'SUBMITTED', startedAt } };
  await page.goto('/');
  const dialog = await openGpu(page);
  const status = dialog.locator('.gpu-status');
  const probe = dialog.getByRole('region', { name: 'GPU probe status' });
  await expect(status).toHaveText('Probe submitted');
  await expect(probe.getByRole('status')).toHaveText('SUBMITTED');
  await expect(dialog.getByText('Probe queued', { exact: true })).toHaveCount(0);

  brain.gpuSetup = { ...brain.gpuSetup, progress: { percent: 30, message: 'Probe is waiting in the SLURM queue' }, probe: { jobId: '12345', state: 'PENDING', startedAt } };
  await expect(status).toHaveText('Probe queued');
  await expect(probe.getByRole('status')).toHaveText('PENDING');

  brain.gpuSetup = { ...brain.gpuSetup, progress: { percent: 85, message: 'Probe left the queue; checking results' }, probe: { jobId: '12345', state: 'FINALIZING', startedAt } };
  await expect(status).toHaveText('Checking probe results');
  await expect(probe.getByRole('status')).toHaveText('FINALIZING');
  await expect(dialog.getByText('Probe queued', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Partition', { exact: true })).toBeDisabled();

  brain.gpuSetup = { ...brain.gpuSetup, phase: 'ready', progress: { percent: 100, message: 'Probe succeeded' }, probe: { jobId: '12345', state: 'COMPLETED', startedAt, finishedAt: new Date().toISOString(), log: 'GPU probe completed successfully.' } };
  await expect(status).toHaveText('Ready');
  await expect(probe.getByRole('status')).toHaveText('COMPLETED');
  await expect(dialog.getByText('The approved probe succeeded. GPU execution is available to permitted agent roles.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel probe', exact: true })).toHaveCount(0);
  expect(brain.writes.filter(write => write.path.startsWith('/gpu/'))).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('structured choices produce an exact preview and only explicit approval queues the reviewed revision', async ({ page }) => {
  const brain = await mockBrain(page); brain.gpuSetup = gpuDraftFixture();
  await page.goto('/');
  await page.getByRole('textbox', { name: 'What do you want to think through?', exact: true }).fill('Preserve my research draft');
  const dialog = await openGpu(page);
  await expect(dialog.getByLabel('Partition', { exact: true }).locator('option')).toHaveText(['gpu_p']);
  await expect(dialog.getByLabel('QOS', { exact: true }).locator('option')).toHaveText(['gpu_normal']);
  await dialog.getByLabel('Account', { exact: true }).selectOption('priority');
  await expect(dialog.getByLabel('QOS', { exact: true }).locator('option')).toHaveText(['gpu_priority', 'gpu_reserved']);
  await dialog.getByLabel('Environment setup', { exact: true }).fill('source /opt/conda.sh\nconda activate research');
  await expect(dialog.getByRole('button', { name: 'Approve and run probe' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save draft and update preview' }).click();
  await expect(dialog.getByLabel('Probe script for approval', { exact: true })).toContainText('conda activate research');
  expect(brain.writes.filter(write => write.path === '/gpu/probe')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Approve and run probe' }).click();
  await expect(dialog.getByRole('region', { name: 'GPU probe status' })).toContainText('PENDING');
  expect(brain.writes.find(write => write.path === '/gpu/probe')?.body).toEqual({ draftId: 'test-gpu-draft', revision: 2, reviewToken: 'test-review-2', approved: true });
  await expect(dialog.getByLabel('Partition', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel probe' }).click();
  await expect(dialog.getByRole('region', { name: 'GPU probe status' })).toContainText('CANCELLED');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'What do you want to think through?', exact: true })).toHaveValue('Preserve my research draft');
  expect(brain.unhandled).toEqual([]);
});

test('stale approval errors are visible and do not silently submit a new script', async ({ page }) => {
  const brain = await mockBrain(page); brain.gpuSetup = gpuDraftFixture();
  await page.goto('/'); const dialog = await openGpu(page);
  const old = brain.gpuSetup.draft!;
  brain.gpuSetup = { ...brain.gpuSetup, draft: { ...old, revision: 2, reviewToken: 'new-review', probeScript: '# Changed by another browser' } };
  await dialog.getByRole('button', { name: 'Approve and run probe' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The GPU draft has changed');
  expect(brain.gpuSetup.phase).toBe('draft');
  await dialog.getByRole('button', { name: 'Refresh GPU status' }).click();
  await expect(dialog.getByLabel('Probe script for approval', { exact: true })).toContainText('Changed by another browser');
  expect(brain.writes.filter(write => write.path === '/gpu/probe')).toHaveLength(1);
});

test('unsaved setup survives dismissal and reservation QOS requires explicit input', async ({ page }) => {
  const brain = await mockBrain(page); brain.gpuSetup = gpuDraftFixture();
  await page.goto('/'); const dialog = await openGpu(page);
  await dialog.getByLabel('Account', { exact: true }).selectOption('priority');
  await dialog.getByLabel('QOS', { exact: true }).selectOption('gpu_reserved');
  await expect(dialog.getByLabel('Reservation (required)', { exact: true })).toHaveAttribute('required', '');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('alert')).toContainText('unsaved GPU settings');
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog.getByLabel('QOS', { exact: true })).toHaveValue('gpu_reserved');
  expect(brain.writes.filter(write => write.path.startsWith('/gpu/'))).toHaveLength(0);
});

test('failed cancellation locks setup until the user retries cleanup', async ({ page }) => {
  const brain = await mockBrain(page);
  brain.gpuSetup = { ...gpuDraftFixture(), phase: 'failed', cleanupRequired: true, error: 'Cancellation could not be confirmed.', probe: { state: 'UNKNOWN', jobId: '12345', startedAt: new Date().toISOString() } };
  await page.goto('/'); const dialog = await openGpu(page);
  await expect(dialog.getByLabel('Partition', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Discover host again' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Approve and run probe' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Retry cancellation' }).click();
  await expect(dialog.getByLabel('Partition', { exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Approve and run probe' })).toBeEnabled();
  expect(brain.writes.filter(write => write.path === '/gpu/probe')).toHaveLength(0);
});

test('a tool toggle preserves GPU access enabled while Settings was already open', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'All settings…', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Tools & sources', exact: true }).click();
  // A completed server probe updates settings outside the settings editor.
  brain.settings = { ...brain.settings, hostTools: { enabledToolIds: [...brain.settings.hostTools!.enabledToolIds, 'gpu_run', 'another_tool'] } };
  await settings.getByRole('switch', { name: /^Code execution/ }).click();
  await expect.poll(() => brain.settings.hostTools?.enabledToolIds).toEqual(['web.search', 'web.fetch', 'gpu_run', 'another_tool', 'code_execute']);
});

for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }]) {
  test(`GPU review fits ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const brain = await mockBrain(page); brain.gpuSetup = gpuDraftFixture();
    await page.goto('/'); const dialog = await openGpu(page);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    await dialog.getByRole('button', { name: 'Approve and run probe' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Approve and run probe' })).toBeInViewport();
  });
}
