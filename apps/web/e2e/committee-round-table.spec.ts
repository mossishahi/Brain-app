import { expect, test, type Locator, type Page } from '@playwright/test';
import type { FirstPassMemberView, JobDetail, JobStatus, ReviewMemberView } from '@brainstorm-agentic/protocol';
import { makeJob, mockBrain } from './fixtures';

const table = (page: Page) => page.getByRole('region', { name: 'Committee round table', exact: true });
const members = (page: Page) => table(page).locator('[data-member-id][role="button"]:not([data-step-index])');
const steps = (page: Page) => table(page).locator('[data-step-index][role="button"]');
const links = (page: Page, verdict: string) => table(page).locator(`path[data-verdict="${verdict}"]`);
const expertise = (page: Page) => table(page).locator('[data-member-expertise]:visible');
const memberConnections = (page: Page) => table(page).getByRole('group', { name: 'Reviewing members', exact: true });

async function setMemberChecked(page: Page, name: string, checked: boolean) {
  const input = memberConnections(page).getByRole('checkbox', { name, exact: true });
  // The visual mark and native input share a label; click that visible target.
  if (await input.isChecked() !== checked) await input.locator('..').click();
  await expect(input).toBeChecked({ checked });
}

async function expectBottomControls(page: Page) {
  expect(await table(page).evaluate(card => {
    const diagram = card.querySelector('.committee-svg')!.getBoundingClientRect();
    return Array.from(card.querySelectorAll('.committee-toolbar, [role="switch"], [role="group"][aria-label="Reviewing members"]'))
      .filter(control => control.getBoundingClientRect().top < diagram.bottom - 1)
      .map(control => control.getAttribute('aria-label') ?? control.className);
  }), 'The toolbar and connection controls sit below the complete drawing').toEqual([]);
}

async function expectStandaloneCard(page: Page) {
  expect(await table(page).evaluate(element => ({
    ownsCard: element.classList.contains('stage'),
    nestedCard: !!element.parentElement?.closest('.stage'),
    hasSiblingCard: Array.from(element.parentElement?.children ?? []).some(sibling => sibling !== element && sibling.classList.contains('stage')),
  }))).toEqual({ ownsCard: true, nestedCard: false, hasSiblingCard: true });
  await expect(table(page).getByRole('button', { name: /^(Zoom in|Zoom out|Fit table)$/ })).toHaveCount(0);
  expect(await table(page).locator('.committee-svg').evaluate(svg => {
    const scrollContainers: string[] = [];
    for (let ancestor = svg.parentElement; ancestor && !ancestor.classList.contains('committee-table'); ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) scrollContainers.push(ancestor.className);
    }
    return scrollContainers;
  }), 'The diagram flows with the page without its own scrolling viewport').toEqual([]);
}

async function expectReadableExpertise(page: Page, count: number) {
  await expect(expertise(page)).toHaveCount(count);
  for (let index = 0; index < count; index++) {
    const label = expertise(page).nth(index);
    await expect(label).toBeVisible();
    await expect(label.locator('[data-expertise-line]')).toHaveCount(3);
    expect(await label.evaluate(element => {
      const rows = Array.from(element.querySelectorAll('[data-expertise-line]')).map(line => line.getBoundingClientRect().height);
      return Math.max(...rows) - Math.min(...rows);
    }), 'Each expertise category occupies exactly one visible line').toBeLessThan(1);
  }
  expect(await table(page).evaluate(card => {
    const box = card.getBoundingClientRect();
    const labels = Array.from(card.querySelectorAll<HTMLElement>('[data-member-expertise]'))
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ id: element.dataset.memberExpertise, box: element.getBoundingClientRect() }));
    const problems: string[] = [];
    for (const [index, label] of labels.entries()) {
      if (label.box.left < box.left - 1 || label.box.right > box.right + 1 || label.box.top < box.top - 1 || label.box.bottom > box.bottom + 1) problems.push(`${label.id} clipped by card`);
      for (const other of labels.slice(index + 1)) {
        if (Math.min(label.box.right, other.box.right) - Math.max(label.box.left, other.box.left) > 1
          && Math.min(label.box.bottom, other.box.bottom) - Math.max(label.box.top, other.box.top) > 1) problems.push(`${label.id} overlaps ${other.id}`);
      }
    }
    for (const line of Array.from(card.querySelectorAll('[data-expertise-line]'))) {
      const bounds = line.getBoundingClientRect();
      if (bounds.width && bounds.height < 15) problems.push(`Unreadably small expertise: ${line.textContent}`);
    }
    return problems;
  }), 'All persistent expertise labels fit without overlapping each other').toEqual([]);
}

async function captureTable(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await table(page).screenshot({ path });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

async function expectColorInputReachable(page: Page) {
  const input = page.getByLabel('Table color', { exact: true });
  await expect.poll(() => input.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit === element || !!hit && element.contains(hit);
  }), { message: 'The palette color input must be visible and receive pointer input' }).toBe(true);
}

function committeeFixture({ stage = 'review-members', status = 'running', memberCount = 4, stepCount = 3, dense = false, mixedVerdicts = false }: {
  stage?: 'first-pass' | 'review-members'; status?: JobStatus; memberCount?: number; stepCount?: number;
  dense?: boolean; mixedVerdicts?: boolean;
} = {}): JobDetail {
  const firstPass: FirstPassMemberView[] = Array.from({ length: memberCount }, (_, index) => ({
    memberId: `member-${index + 1}`, label: `Seat ${index + 1}`,
    department: index === 0 ? 'Mathematics' : 'Natural sciences',
    umbrella: index === 0 ? 'Geometry' : 'Scientific reasoning',
    subfields: index === 0 ? ['Riemannian geometry'] : [`Research specialty ${index + 1}`],
    status: stage === 'first-pass' ? index === 0 ? 'thinking' : 'pending' : 'completed',
    ...(stage === 'review-members' ? { idea: {
      type: 'explanation', shape: 'explanation' as const,
      cot: Array.from({ length: stepCount }, (_, step) => `Seat ${index + 1} original thought ${step + 1}.`),
    } } : {}),
  }));
  const review: ReviewMemberView[] = firstPass.map((member, index) => ({
    memberId: member.memberId, label: member.label, department: member.department, umbrella: member.umbrella,
    steps: Array.from({ length: stepCount }, (_, step) => ({
      index: step + 1, outcome: index === 0 && step === 1 ? 'under-review' : 'passed',
      rounds: [{ round: 1, cot: member.idea?.cot[step] ?? `Seat ${index + 1} original thought ${step + 1}.`, comments: dense ? firstPass.flatMap((reviewer, reviewerIndex) => reviewer.memberId === member.memberId ? [] : [{
        commentorId: reviewer.memberId, commentorLabel: reviewer.label,
        verdict: (['Pass', 'Interrupt', 'Build'] as const)[reviewerIndex % 3]!, step: step + 1, reason: 'A recorded cross-member review.',
      }]) : index === 0 && step === 0 ? [
        { commentorId: 'member-2', commentorLabel: 'Seat 2', verdict: 'Pass', reason: 'The argument is supported.' },
        { commentorId: 'member-3', commentorLabel: 'Seat 3', verdict: 'Interrupt', step: 1, reason: 'Check the boundary assumption.' },
        { commentorId: 'member-4', commentorLabel: 'Seat 4', verdict: 'Build', step: 1, reason: 'Extend the calculation.' },
        { commentorId: 'unmapped-reviewer', commentorLabel: 'Unmapped expert', verdict: 'Pass', reason: 'Unknown identities must not create fabricated seats.' },
        { commentorId: member.memberId, commentorLabel: member.label, verdict: 'Pass', reason: 'A self-comment must not become a cross-member connection.' },
      ] : [] }, ...(mixedVerdicts && index === 0 && step === 0 ? (['Interrupt', 'Build'] as const).map((verdict, round) => ({
        // The server stores one comment per reviewer per round. Multiple
        // verdicts on the same graph endpoints arise across review rounds.
        round: round + 2,
        cot: member.idea?.cot[step] ?? `Seat ${index + 1} original thought ${step + 1}.`,
        comments: [{ commentorId: 'member-2', commentorLabel: 'Seat 2', verdict, step: 1, reason: 'A later round revisits the same step.' }],
      })) : [])],
    })),
    ...(index === 0 ? { progress: { step: 2, stepCount, round: 1, phase: 'commenting' as const } } : {}),
  }));
  return {
    ...makeJob(1, { jobId: 'committee-fixture', title: 'A committee exploring a geometric hypothesis', status }),
    stages: [
      { id: 'process-input', status: 'completed', output: {
        title: 'A geometric hypothesis', question: 'Does the construction preserve geodesics?', context: '',
        attachments: [], assumptions: [], cotSteps: stepCount,
      } },
      { id: 'first-pass', status: stage === 'first-pass' ? 'active' : 'completed', members: firstPass },
      ...(stage === 'review-members' ? [{ id: 'review-members' as const, status: 'active' as const, maxRounds: 9, members: review }] : []),
    ],
  };
}

async function openCommittee(page: Page, options: Parameters<typeof committeeFixture>[0] = {}) {
  const detail = committeeFixture(options);
  const brain = await mockBrain(page, { jobs: [detail] });
  await page.route(/\/api\/jobs\/committee-fixture(?:\/stream)?(?:\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (new URL(route.request().url()).pathname.endsWith('/stream')) return route.fulfill({
      contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'job', job: detail })}\n\n`,
    });
    return route.fulfill({ json: detail });
  });
  await page.route('**/api/availability', route => route.fulfill({
    json: { version: 1, updatedAt: Date.now(), tools: [], purposes: [], demoteDegraded: false },
  }));
  await page.addInitScript(() => localStorage.setItem('brain.appearance.v1', JSON.stringify({
    version: 1, preferences: { background: 'none', theme: 'dark' },
  })));
  await page.goto(`/#/jobs/committee-fixture/stage/${options.stage ?? 'review-members'}`);
  await expect(table(page)).toBeVisible();
  return brain;
}

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', error => messages.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page) ?? [], 'No uncaught browser errors').toEqual([]));

test('renders real thinking steps and only recorded cross-member review contributions', async ({ page }) => {
  const brain = await openCommittee(page);
  await expect(members(page)).toHaveCount(4);
  // The fixture has nine review rounds available, but only three thinking steps.
  await expect(steps(page)).toHaveCount(12);
  await expect(links(page, 'Pass')).toHaveCount(1);
  await expect(links(page, 'Interrupt')).toHaveCount(1);
  await expect(links(page, 'Build')).toHaveCount(1);
  await expect(table(page).locator('[data-member-id="unmapped-reviewer"]')).toHaveCount(0);
  await expect(page.locator('.matrix')).toHaveCount(0);
  await expectStandaloneCard(page);
  await expectBottomControls(page);
  await expectReadableExpertise(page, 4);
  await captureTable(page, 'committee-round-table-desktop');
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
  expect(brain.unhandled).toEqual([]);
  await openCommittee(page, { memberCount: 5 });
  await expect(members(page)).toHaveCount(5);
  await expect(steps(page)).toHaveCount(15);
  await captureTable(page, 'committee-round-table-five-members');
  await openCommittee(page, { memberCount: 4 });
  await expect(members(page)).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await captureTable(page, 'committee-round-table-four-members-phone');
  await table(page).getByRole('button', { name: 'Table colors', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Table colors', exact: true });
  await expect(palette).toBeVisible();
  await expect.poll(async () => (await palette.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  const paletteBounds = (await palette.boundingBox())!;
  expect(paletteBounds.x + paletteBounds.width).toBeLessThanOrEqual(391);
  expect(paletteBounds.y).toBeGreaterThanOrEqual(0);
  expect(paletteBounds.y + paletteBounds.height).toBeLessThanOrEqual(844);
  await expectColorInputReachable(page);
  const palettePath = test.info().outputPath('committee-round-table-phone-colors.png');
  await page.screenshot({ path: palettePath });
  await test.info().attach('committee-round-table-phone-colors', { path: palettePath, contentType: 'image/png' });
  await palette.getByLabel('Table color', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(palette).not.toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await table(page).getByRole('button', { name: 'Table colors', exact: true }).click();
  await expect(palette).toBeVisible();
  await expectColorInputReachable(page);
  const landscape = (await palette.boundingBox())!;
  expect(landscape.x).toBeGreaterThanOrEqual(0);
  expect(landscape.x + landscape.width).toBeLessThanOrEqual(844);
  expect(landscape.y).toBeGreaterThanOrEqual(0);
  expect(landscape.y + landscape.height).toBeLessThanOrEqual(390);
  await palette.getByLabel('Table color', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const darkTableFill = await table(page).locator('[data-shape="table"]').getAttribute('fill');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect(table(page).locator('[data-shape="table"]')).not.toHaveAttribute('fill', darkTableFill!);
  await captureTable(page, 'committee-round-table-four-members-light');
});

test('filters each verdict independently using switches without changing the research', async ({ page }) => {
  const brain = await openCommittee(page);
  for (const verdict of ['Pass', 'Interrupt', 'Build']) {
    const toggle = table(page).getByRole('switch', { name: `${verdict} connections`, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(links(page, verdict)).toHaveCount(0);
    for (const other of ['Pass', 'Interrupt', 'Build'].filter(value => value !== verdict)) {
      await expect(links(page, other)).toHaveCount(1);
    }
    await toggle.click();
    await expect(links(page, verdict)).toHaveCount(1);
  }
  await expect(table(page).getByRole('group', { name: 'Review connections', exact: true }).getByRole('checkbox')).toHaveCount(0);
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

test('member checkboxes combine multiple selections and support all or none with the keyboard', async ({ page }) => {
  const brain = await openCommittee(page);
  const group = memberConnections(page);
  const all = group.getByRole('checkbox', { name: 'All members', exact: true });
  await expect(group.getByRole('checkbox')).toHaveCount(5);
  for (const checkbox of await group.getByRole('checkbox').all()) await expect(checkbox).toBeChecked();
  await expect(table(page).getByRole('combobox', { name: 'Connection focus', exact: true })).toHaveCount(0);
  await expectBottomControls(page);
  await all.focus();
  await page.keyboard.press('Space');
  await expect(all).not.toBeChecked();
  await expect(table(page).locator('path[data-verdict]')).toHaveCount(0);

  await setMemberChecked(page, 'Seat 2', true);
  const seat3 = group.getByRole('checkbox', { name: 'Seat 3', exact: true });
  await seat3.focus();
  await page.keyboard.press('Space');
  await expect(seat3).toBeChecked();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await expect(links(page, 'Pass')).toHaveCount(1);
  await expect(links(page, 'Interrupt')).toHaveCount(1);
  await expect(links(page, 'Build')).toHaveCount(0);
  // Multiple reviewers combine their outgoing contributions, and verdict
  // switches continue narrowing that selected subset.
  await table(page).getByRole('switch', { name: 'Interrupt connections', exact: true }).click();
  await expect(links(page, 'Interrupt')).toHaveCount(0);
  await expect(links(page, 'Pass')).toHaveCount(1);
  await setMemberChecked(page, 'Seat 4', true);
  await expect(links(page, 'Build')).toHaveCount(1);
  await table(page).getByRole('switch', { name: 'Interrupt connections', exact: true }).click();
  await setMemberChecked(page, 'All members', true);
  await expect(all).toHaveJSProperty('indeterminate', false);
  for (const checkbox of await group.getByRole('checkbox').all()) await expect(checkbox).toBeChecked();
  await expect(table(page).locator('path[data-verdict]')).toHaveCount(3);
  await setMemberChecked(page, 'Seat 2', false);
  await expect(links(page, 'Pass')).toHaveCount(0);
  await expect(links(page, 'Interrupt')).toHaveCount(1);
  await expect(links(page, 'Build')).toHaveCount(1);
  await setMemberChecked(page, 'All members', true);
  await setMemberChecked(page, 'All members', false);
  await setMemberChecked(page, 'Seat 1', true);
  // Seat 1 receives all three reviews but contributes none, so its selection
  // must not bring the other members' outgoing reviews back into view.
  await expect(table(page).locator('path[data-verdict]')).toHaveCount(0);
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

test('the standalone table follows the selected stage collapse state', async ({ page }) => {
  for (const [stage, title] of [['review-members', 'Review'], ['first-pass', 'First pass']] as const) {
    await openCommittee(page, { stage });
    await expectStandaloneCard(page);
    await page.getByRole('button', { name: `collapse ${title} panel`, exact: true }).click();
    await expect(table(page)).toHaveCount(0);
    await page.getByRole('button', { name: `expand ${title} panel`, exact: true }).click();
    await expect(table(page)).toBeVisible();
    await expectStandaloneCard(page);
    await expect(members(page)).toHaveCount(4);
  }
});

test('three-line expertise stays visible without hovering and LEDs still select the detailed walk', async ({ page }) => {
  await openCommittee(page);
  await expectReadableExpertise(page, 4);
  const first = table(page).locator('.committee-person[data-member-id="member-1"]');
  const firstExpertise = expertise(page).filter({ hasText: 'Riemannian geometry' });
  await expect(firstExpertise.locator('[data-expertise-line]')).toHaveText(['Mathematics', 'Geometry', 'Riemannian geometry']);
  await expect(expertise(page).filter({ hasText: 'Research specialty 2' })).toBeVisible();
  await first.hover();
  await table(page).locator('.committee-person[data-member-id="member-2"]').hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  // Only explicit filters remove connections from the drawing.
  await expect(links(page, 'Pass')).toHaveCount(1);
  await expect(links(page, 'Interrupt')).toHaveCount(1);
  await expect(links(page, 'Build')).toHaveCount(1);
  await page.mouse.move(1430, 10);
  await first.focus();
  await expect(firstExpertise).toBeVisible();
  const secondStep = table(page).getByRole('button', { name: /^Seat 2, step 2:/ });
  await secondStep.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.seat-pager-label')).toHaveText('Seat 2 / 4');
  await expect(page.locator('.review-card').nth(1)).toContainText('Seat 2 original thought 2.');
  await expect(page.locator('.review-card').nth(1)).toBeInViewport();
});

test('thinking lights follow the inner rim and each source bulb sits on the table', async ({ page }) => {
  await openCommittee(page, { memberCount: 4, stepCount: 7 });
  await expect(steps(page)).toHaveCount(28);
  const geometry = await table(page).evaluate(element => {
    const surface = element.querySelector<SVGCircleElement>('circle[data-shape="table"]')!;
    const point = (shape: SVGGraphicsElement, x: number, y: number) => new DOMPoint(x, y).matrixTransform(shape.getScreenCTM()!);
    const center = point(surface, surface.cx.baseVal.value, surface.cy.baseVal.value);
    const outside = point(surface, surface.cx.baseVal.value + surface.r.baseVal.value, surface.cy.baseVal.value);
    const radius = Math.hypot(outside.x - center.x, outside.y - center.y);
    const circleData = (circle: SVGCircleElement) => {
      const location = point(circle, circle.cx.baseVal.value, circle.cy.baseVal.value);
      const edge = point(circle, circle.cx.baseVal.value + circle.r.baseVal.value, circle.cy.baseVal.value);
      return { x: location.x, y: location.y, radius: Math.hypot(edge.x - location.x, edge.y - location.y), distance: Math.hypot(location.x - center.x, location.y - center.y), angle: Math.atan2(location.y - center.y, location.x - center.x) };
    };
    const lights = Array.from(element.querySelectorAll<SVGCircleElement>('.committee-led-light')).map(circle => ({ ...circleData(circle), member: circle.closest('[data-member-id]')!.getAttribute('data-member-id') }));
    const bulbs = Array.from(element.querySelectorAll<SVGGElement>('[data-agent-node]')).map(group => {
      const id = group.getAttribute('data-agent-node')!;
      const bulb = circleData(group.querySelector<SVGCircleElement>('circle[fill]:not([fill="transparent"])')!);
      const person = element.querySelector<SVGGElement>(`.committee-person[data-member-id="${id}"]`)!;
      const bounds = person.getBoundingClientRect();
      const overlapsPerson = bulb.x + bulb.radius > bounds.left && bulb.x - bulb.radius < bounds.right
        && bulb.y + bulb.radius > bounds.top && bulb.y - bulb.radius < bounds.bottom;
      return { ...bulb, member: id, overlapsPerson };
    });
    const scale = radius / surface.r.baseVal.value;
    const gaps = Array.from(element.querySelectorAll<SVGGElement>('.committee-person')).map(person => {
      const head = circleData(person.querySelector<SVGCircleElement>('.committee-head')!);
      const body = person.querySelector<SVGRectElement>('.committee-body')!.getBoundingClientRect();
      const nearestX = Math.min(body.right, Math.max(body.left, center.x));
      const nearestY = Math.min(body.bottom, Math.max(body.top, center.y));
      return (Math.min(head.distance - head.radius, Math.hypot(nearestX - center.x, nearestY - center.y)) - radius) / scale;
    });
    return { radius, lights, bulbs, gaps };
  });
  expect(geometry.lights).toHaveLength(28);
  const distances = geometry.lights.map(light => light.distance);
  expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(1);
  for (const light of geometry.lights) {
    expect(light.distance / geometry.radius).toBeGreaterThan(.8);
    expect(light.distance + light.radius).toBeLessThanOrEqual(geometry.radius + 1);
  }
  const right = geometry.lights.filter(light => light.member === 'member-2');
  const xSpan = Math.max(...right.map(light => light.x)) - Math.min(...right.map(light => light.x));
  const ySpan = Math.max(...right.map(light => light.y)) - Math.min(...right.map(light => light.y));
  expect(ySpan).toBeGreaterThan(1);
  // A real arc bends in both axes rather than becoming a rotated straight row.
  expect(xSpan).toBeGreaterThan(1);
  expect(geometry.bulbs).toHaveLength(4);
  for (const [index, bulb] of geometry.bulbs.entries()) {
    expect(bulb.distance + bulb.radius).toBeLessThanOrEqual(geometry.radius + 1);
    expect(bulb.distance / geometry.radius).toBeGreaterThan(.8);
    expect(bulb.overlapsPerson).toBe(false);
    const sectorAngle = index * 2 * Math.PI / geometry.bulbs.length - Math.PI / 2;
    const angleError = Math.atan2(Math.sin(bulb.angle - sectorAngle), Math.cos(bulb.angle - sectorAngle));
    expect(Math.abs(angleError), 'The bulb is directly in front of its member').toBeLessThan(.001);
    const offsets = geometry.lights.filter(light => light.member === bulb.member)
      .map(light => (light.angle - bulb.angle + 2 * Math.PI) % (2 * Math.PI));
    expect(offsets).toHaveLength(7);
    expect(offsets[0], 'The first LED starts clockwise after the bulb').toBeGreaterThan(0);
    for (let step = 1; step < offsets.length; step++) expect(offsets[step]).toBeGreaterThan(offsets[step - 1]!);
    expect(offsets.at(-1)!, 'Every LED remains before the next member sector').toBeLessThan(2 * Math.PI / geometry.bulbs.length);
  }
  for (const gap of geometry.gaps) expect(gap).toBeCloseTo(12, 0);
  await expect(table(page).locator('.committee-step-number')).toHaveCount(0);
  expect(await table(page).locator('svg text').evaluateAll(labels => labels.filter(label => /^\d+$/.test(label.textContent?.trim() ?? '')).length)).toBe(0);
  const darkTableFill = await table(page).locator('[data-shape="table"]').getAttribute('fill');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect(table(page).locator('[data-shape="table"]')).not.toHaveAttribute('fill', darkTableFill!);
  await captureTable(page, 'committee-inner-rim-four-by-seven-light');
});

test('palette changes persist after reload and do not modify pipeline settings', async ({ page }) => {
  const brain = await openCommittee(page);
  await table(page).getByRole('button', { name: 'Table colors', exact: true }).hover();
  const input = page.getByLabel('Table color', { exact: true });
  await expect(input).toBeVisible();
  await input.hover();
  // Deliberately stay past the hover-dismiss grace period while the pointer
  // moves from the trigger into the floating palette.
  await page.waitForTimeout(300);
  await expect(input).toBeVisible();
  await input.focus();
  await input.evaluate((element: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '#152b38');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(input).toHaveValue('#152b38');
  await page.reload();
  await expect(table(page)).toBeVisible();
  await table(page).getByRole('button', { name: 'Table colors', exact: true }).click();
  await expect(page.getByLabel('Table color', { exact: true })).toHaveValue('#152b38');
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

test('step lights, agent nodes and review connections have independent colors', async ({ page }) => {
  const brain = await openCommittee(page);
  const passedLight = table(page).locator('.committee-led[data-member-id="member-2"][data-step-index="1"] .committee-led-light');
  const completedAgent = table(page).locator('[data-agent-node="member-2"] circle[fill]:not([fill="transparent"])').first();
  const passLink = links(page, 'Pass');
  const originalAgent = await completedAgent.getAttribute('fill');
  const originalLink = await passLink.getAttribute('stroke');
  await table(page).getByRole('button', { name: 'Table colors', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Table colors', exact: true });
  const change = async (label: string, color: string) => {
    const input = palette.getByLabel(label, { exact: true });
    await input.evaluate((element: HTMLInputElement, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, color);
    await expect(input).toHaveValue(color);
  };
  await palette.getByRole('button', { name: 'Steps', exact: true }).click();
  await change('Step passed color', '#c050a0');
  await expect(passedLight).toHaveAttribute('fill', '#c050a0');
  await expect(completedAgent).toHaveAttribute('fill', originalAgent!);
  await expect(passLink).toHaveAttribute('stroke', originalLink!);
  await palette.getByRole('button', { name: 'Agents', exact: true }).click();
  await change('Agent completed color', '#aa7722');
  await expect(completedAgent).toHaveAttribute('fill', '#aa7722');
  await expect(passedLight).toHaveAttribute('fill', '#c050a0');
  await expect(passLink).toHaveAttribute('stroke', originalLink!);
  await palette.getByRole('button', { name: 'Links', exact: true }).click();
  await change('Pass connections color', '#357fa8');
  await expect(passLink).toHaveAttribute('stroke', '#357fa8');
  await expect(completedAgent).toHaveAttribute('fill', '#aa7722');
  await expect(passedLight).toHaveAttribute('fill', '#c050a0');
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

test('the selected member retains its existing stop confirmation', async ({ page }) => {
  const brain = await openCommittee(page);
  await table(page).getByRole('button', { name: /^Seat 2 —/ }).click();
  await page.getByRole('button', { name: 'Manage Seat 2', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Stop this seat', exact: true }).click();
  await expect(dialog).toContainText('Stop Seat 2?');
  await expect(dialog.getByRole('button', { name: 'Yes, stop it', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'No', exact: true }).click();
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

async function activeAnimations(target: Locator) {
  return target.evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running').length);
}

test('first-pass thinking pulses only during a live run and honors reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openCommittee(page, { stage: 'first-pass' });
  await expectStandaloneCard(page);
  await expectBottomControls(page);
  await expectReadableExpertise(page, 4);
  await expect(steps(page)).toHaveCount(12);
  await expect(table(page).locator('[data-thinking="true"]')).toHaveCount(1);
  await expect.poll(() => activeAnimations(table(page))).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => activeAnimations(table(page))).toBe(0);
  // Reduced motion changes presentation only; expertise/status stay available.
  await expect(table(page).getByRole('button', { name: /^Seat 1 — thinking/ })).toBeVisible();
});

test('a paused first pass never continues the thinking pulse from its stale task status', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openCommittee(page, { stage: 'first-pass', status: 'paused' });
  await expect(table(page).locator('[data-thinking="true"]')).toHaveCount(0);
  await expect.poll(() => activeAnimations(table(page))).toBe(0);
  await expect(steps(page)).toHaveCount(12);
});

test('a large committee keeps all steps accessible on a narrow phone', async ({ page }) => {
  const brain = await openCommittee(page, { memberCount: 12, stepCount: 16 });
  await expect(members(page)).toHaveCount(12);
  await expect(steps(page)).toHaveCount(192);
  await expectStandaloneCard(page);
  await expectBottomControls(page);
  await expectReadableExpertise(page, 12);
  await captureTable(page, 'committee-round-table-twelve-members-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectReadableExpertise(page, 12);
  await expectBottomControls(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The dashboard stage translates in on entry. Measure the settled table,
  // not the first visible animation frame.
  await expect.poll(async () => {
    const bounds = (await table(page).boundingBox())!;
    return bounds.x + bounds.width;
  }).toBeLessThanOrEqual(391);
  const bounds = (await table(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  await captureTable(page, 'committee-round-table-phone');
  // The phone ribbon is fixed. Page scrolling must still expose the roster
  // without trapping its first or last member beneath that ribbon.
  for (const label of [expertise(page).first(), expertise(page).last()]) {
    await label.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await expect.poll(() => label.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === element || !!hit && element.contains(hit);
    })).toBe(true);
  }
  const step = table(page).getByRole('button', { name: /^Seat 12, step 16:/ });
  await step.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.seat-pager-label')).toHaveText('Seat 12 / 12');
  await expect(page.locator('.review-card').nth(15)).toBeInViewport();
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});

test('different review verdicts between the same nodes remain distinguishable', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', message => {
    if (/same key|unique.*key|duplicate.*key/i.test(message.text())) warnings.push(message.text());
  });
  await openCommittee(page, { mixedVerdicts: true });
  const pair = table(page).locator('path[data-source="member-2"][data-target="member-1"][data-target-step="1"]');
  await expect(pair).toHaveCount(3);
  const paths = await pair.evaluateAll(elements => elements.map(element => element.getAttribute('d')));
  expect(new Set(paths).size).toBe(3);
  await table(page).getByRole('switch', { name: 'Interrupt connections', exact: true }).click();
  await expect(pair).toHaveCount(2);
  expect(await pair.evaluateAll(elements => elements.map(element => element.getAttribute('data-verdict')).sort())).toEqual(['Build', 'Pass']);
  expect(warnings).toEqual([]);
});

test('dense review histories draw their connections and remain filterable', async ({ page }) => {
  const brain = await openCommittee(page, { memberCount: 12, stepCount: 16, dense: true });
  const canvas = table(page).locator('canvas');
  const caption = table(page).locator('.committee-caption');
  await expect(caption).toContainText('2112 review connections');
  await expect(canvas).toHaveCount(1);
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
    const pixels = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! > 0) return true;
    return false;
  })).toBe(true);
  for (const [index, verdict] of ['Pass', 'Interrupt', 'Build'].entries()) {
    await table(page).getByRole('switch', { name: `${verdict} connections`, exact: true }).click();
    await expect(caption).toContainText(`${2112 - (index + 1) * 704} review connections`);
  }
  await expect(canvas).toHaveCount(0);
  await table(page).getByRole('switch', { name: 'Pass connections', exact: true }).click();
  await expect(caption).toContainText('704 review connections');
  await setMemberChecked(page, 'All members', false);
  await expect(caption).toContainText('0 review connections');
  await setMemberChecked(page, 'Seat 1', true);
  await expect(caption).toContainText('176 review connections');
  await expect(links(page, 'Pass')).toHaveCount(176);
  await setMemberChecked(page, 'Seat 4', true);
  await expect(caption).toContainText('352 review connections');
  await expect(links(page, 'Pass')).toHaveCount(352);
  expect(await links(page, 'Pass').evaluateAll(paths => [...new Set(paths.map(path => path.getAttribute('data-source')))].sort())).toEqual(['member-1', 'member-4']);
  expect(brain.writes.filter(write => write.path !== '/update-check')).toEqual([]);
});
