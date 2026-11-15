import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { JobDetail, LiteratureReviewView } from '@brainstorm-agentic/protocol';
import { makeJob, mockBrain } from './fixtures';

function review(role: string, taskId: string, stage: string): LiteratureReviewView {
  return {
    reviewId: `${role}-review`, revision: 2, state: 'submitted', owner: { runId: 'literature-fixture', taskId, agentId: role, nodePath: `brainstorm-root/${stage}/${taskId}`, role },
    inputRevision: 'input-1', inputRequirements: [{ id: 'R1', text: 'Preserve independent geometric directions' }], createdAt: 1, updatedAt: 2,
    review: { schemaVersion: 'literature-review/v1', scope: { question: `${role} source assessment`, inputRequirements: [{ id: 'R1', text: 'Preserve independent geometric directions' }], vantage: `${role} perspective` },
      search: { queries: [{ query: 'independent coordinates', source: 'Scholarly index', evidenceRefIds: [] }], coverage: 'Relevant inspected method sections', limitations: ['This is a targeted assessment.'] },
      works: [{ id: 'source-1', source: { title: `${role} inspected source`, authors: ['A. Author'], year: 2024, venue: 'Example Journal', url: 'https://example.org/paper.pdf', doi: null, version: 'source-sha256' },
        inspected: { level: 'sections', evidence: [{ documentId: 'doc-1', receiptId: `${role}-receipt`, segmentId: 'page-2', locator: 'page 2, Method, characters 0–80' }], accessLimitations: ['Appendix was inaccessible.'] },
        method: 'Tests whether coordinates repeat a previously represented direction.', results: 'Reports a controlled comparison.', conditions: ['Matched sampling conditions'], limitations: ['No guarantee for noisy measurements'],
        relevance: [{ requirementId: 'R1', relationship: 'partially-addresses', justification: 'Checks the direction-loss mechanism in the original request.' }], intendedUse: ['A comparison baseline'], uncertainties: ['Sensitivity to sample density remains unclear.'],
      }], synthesis: { closestWorkIds: ['source-1'], assessment: 'partially-solved', findings: 'A baseline exists under the inspected conditions.', gaps: ['Noise remains unresolved.'], comparisons: [] }, status: 'complete', statusReason: 'This scoped review records inspected evidence and limitations.' },
  };
}

test('each output ends with its own review; other roles remain accessible and downloads preserve ownership', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const thinker = review('thinker', 'thinker-task', 'first-pass');
  const integrator = review('integrator', 'audit-task', 'bridge-audit');
  const detail: JobDetail = { ...makeJob(1, { jobId: 'literature-fixture', title: 'Owned literature deliverables' }), stages: [
    { id: 'first-pass', status: 'completed', literatureReviews: [thinker], members: [{ memberId: 'thinker', label: 'Seat 1', department: 'Mathematics', umbrella: 'Geometry', subfields: [], status: 'completed', idea: {
      type: 'research idea', shape: 'paper', cot: ['A supported argument.'], paper: { abstract: 'An original abstract.', introduction: 'Original context.', method: 'Original method.', discussion: 'Original discussion.', conclusion: 'Original conclusion.' }, literatureReviews: [thinker],
    } }] },
    { id: 'bridge-audit', status: 'completed', literatureReviews: [integrator] },
  ] };
  const brain = await mockBrain(page, { jobs: [detail] });
  await page.route(/\/api\/jobs\/literature-fixture(?:\/stream)?(?:\?|$)/, route => new URL(route.request().url()).pathname.endsWith('/stream')
    ? route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'job', job: detail })}\n\n` })
    : route.fulfill({ json: detail }));
  await page.route('**/api/availability', route => route.fulfill({ json: { version: 1, updatedAt: Date.now(), tools: [], purposes: [], demoteDegraded: false } }));
  await page.goto('/#/jobs/literature-fixture/stage/first-pass');
  const bibliography = page.getByRole('region', { name: 'Literature review and sources', exact: true });
  await expect(bibliography).toBeVisible();
  await expect(page.locator('.idea-tab-content > :last-child')).toHaveClass('literature-reviews');
  await expect(page.locator('.idea-tab-content')).toContainText('Original conclusion.');
  await bibliography.locator('summary').first().click();
  await expect(bibliography.getByRole('link', { name: 'thinker inspected source' })).toHaveAttribute('href', 'https://example.org/paper.pdf');
  await expect(bibliography).toContainText('Preserve independent geometric directions');
  await expect(bibliography).toContainText('Checks the direction-loss mechanism in the original request.');
  await expect(bibliography).toContainText('Appendix was inaccessible.');
  await expect(bibliography).toContainText('No guarantee for noisy measurements');
  await bibliography.getByText('Source locations (1)', { exact: true }).click();
  await expect(bibliography).toContainText('page 2, Method, characters 0–80');
  await expect(bibliography).toContainText('thinker-receipt');
  await expect(bibliography).not.toContainText('integrator inspected source');
  const downloadPromise = page.waitForEvent('download');
  await bibliography.getByRole('button', { name: "Download this agent's review", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('literature-thinker-review.json');
  const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(saved.owner.taskId).toBe('thinker-task');
  expect(saved.review.works[0].inspected.evidence[0].receiptId).toBe('thinker-receipt');
  await page.getByRole('group', { name: 'pipeline stages', exact: true }).getByRole('button', { name: /^Audit stage:/ }).click();
  const fallback = page.getByRole('region', { name: 'Agent literature reviews', exact: true });
  await fallback.locator('summary').first().click();
  await expect(fallback.getByRole('link', { name: 'integrator inspected source' })).toBeVisible();
  await expect(fallback).toContainText('Task: audit-task');
  await expect(fallback).not.toContainText('thinker inspected source');
  expect(errors).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});
