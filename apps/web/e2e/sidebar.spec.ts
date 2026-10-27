import { expect, test, type Locator, type Page } from '@playwright/test';
import { makeJob, mockBrain } from './fixtures';

const errors = new WeakMap<Page, string[]>();
const prompt = (page: Page) => page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Research library', exact: true });
const rows = (page: Page) => panel(page).locator('.library-row');

test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? [], 'No uncaught browser errors').toEqual([]);
});

async function openLibrary(page: Page, section: 'history' | 'trash' = 'history') {
  await page.locator(`#sidebar-${section}-trigger`).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator(`#sidebar-${section}-trigger`)).toHaveAttribute('aria-expanded', 'true');
  return panel(page);
}

async function inViewport(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  // A visible floating panel may still be entering from off-screen. Measure its settled
  // position instead of racing the animation or adding an arbitrary sleep.
  await expect.poll(async () => (await target.boundingBox())?.x ?? -Infinity).toBeGreaterThanOrEqual(-1);
  const box = (await target.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
}

test('library opens, switches lists and collapses without replacing the composer', async ({ page }) => {
  const brain = await mockBrain(page, { trash: [makeJob(80, { title: 'Archived hypothesis', trashedAt: Date.now(), status: 'cancelled' })] });
  await page.goto('/');
  await prompt(page).fill('Keep my work here while I search earlier research.');
  const originalInput = await prompt(page).elementHandle();
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(prompt(page)).toBeVisible();
  await page.locator('#sidebar-trash-trigger').click();
  await expect(panel(page).getByRole('textbox', { name: 'Search trash', exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(panel(page).getByRole('link', { name: 'Open research: Archived hypothesis', exact: true })).toBeVisible();
  await expect(prompt(page)).toHaveValue('Keep my work here while I search earlier research.');
  await page.locator('#sidebar-history-trigger').click();
  await expect(rows(page)).toHaveCount(2);
  await page.locator('#sidebar-history-trigger').click();
  await expect(panel(page)).not.toBeVisible();
  expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(prompt(page)).toHaveValue('Keep my work here while I search earlier research.');
  expect(brain.writes.filter((write) => write.path.startsWith('/jobs'))).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('a delayed library module preserves focus when the user returns to the composer', async ({ page }) => {
  const brain = await mockBrain(page);
  let releaseModule!: () => void;
  const moduleGate = new Promise<void>((resolve) => { releaseModule = resolve; });
  let moduleRequested!: () => void;
  const pendingModule = new Promise<void>((resolve) => { moduleRequested = resolve; });
  await page.route((url) => url.pathname === '/src/features/library/LibraryList.tsx'
    || /^\/assets\/LibraryList-[^/]+\.js$/.test(url.pathname), async (route) => {
    moduleRequested();
    await moduleGate;
    await route.continue();
  });
  try {
    await page.goto('/');
    await openLibrary(page);
    await pendingModule;
    await expect(panel(page).getByRole('status')).toHaveText('Opening your library…');
    await prompt(page).click();
    await page.keyboard.type('I am continuing my draft');
    await expect(prompt(page)).toBeFocused();
    releaseModule();
    await expect(page.locator('#research-sidebar input[aria-label="Search research history"]')).toBeAttached();
    await expect(panel(page)).not.toBeVisible();
    // The lazy list may finish loading after dismissal. Its focus effect must
    // respect the user's newer focus and leave the panel closed.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(prompt(page)).toBeFocused();
    await page.keyboard.type(' after the library is ready.');
    await expect(prompt(page)).toHaveValue('I am continuing my draft after the library is ready.');
    await expect(panel(page)).not.toBeVisible();
    await openLibrary(page);
    await expect(panel(page).getByRole('textbox', { name: 'Search research history', exact: true })).toHaveValue('');
    expect(brain.writes.filter((write) => write.path.startsWith('/jobs'))).toEqual([]);
    expect(brain.unhandled).toEqual([]);
  } finally {
    releaseModule();
  }
});

test('library browsing preserves the exact Dashboard DOM and its local confirmation state', async ({ page }) => {
  const brain = await mockBrain(page, { jobs: [makeJob(1, { status: 'running' }), makeJob(2)], trash: [makeJob(80, { trashedAt: Date.now(), status: 'cancelled' })] });
  await page.goto('/#/jobs/test-run-1/stage/first-pass');
  const dashboard = page.locator('.dash');
  await expect(page.locator('.dash-title')).toHaveText('Research record 1');
  const originalDashboard = await dashboard.elementHandle();
  await dashboard.getByRole('button', { name: 'stop this run — it cannot continue afterwards', exact: true }).click();
  await expect(dashboard.getByRole('button', { name: 'Keep it', exact: true })).toBeVisible();
  const initialLoads = brain.requests.filter((request) => request.path === '/jobs/test-run-1').length;
  await openLibrary(page);
  await panel(page).getByRole('textbox', { name: 'Search research history', exact: true }).fill('record 2');
  await page.locator('#sidebar-trash-trigger').click();
  await page.keyboard.press('Escape');
  expect(await originalDashboard!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(dashboard.getByRole('button', { name: 'Keep it', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/jobs\/test-run-1\/stage\/first-pass(?:\?|$)/);
  expect(brain.requests.filter((request) => request.path === '/jobs/test-run-1')).toHaveLength(initialLoads);
  expect(brain.writes.filter((write) => write.path.startsWith('/jobs'))).toEqual([]);
  await openLibrary(page);
  await panel(page).getByRole('textbox', { name: 'Search research history', exact: true }).fill('record 2');
  await panel(page).getByRole('link', { name: 'Open research: Research record 2', exact: true }).click();
  await expect(page.locator('.dash-title')).toHaveText('Research record 2');
  await expect(page).toHaveURL(/#\/jobs\/test-run-2(?:\?|$)/);
  await expect(panel(page)).not.toBeVisible();
  await openLibrary(page);
  await expect(panel(page).getByRole('link', { name: 'Open research: Research record 2', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('floating library leaves the workspace in place and ignores the retired width preference', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('brain.sidebar.width.v1', '520'));
  await mockBrain(page);
  await page.goto('/');
  await prompt(page).fill('My question stays still when I browse earlier research.');
  const originalInput = await prompt(page).elementHandle();
  const originalBounds = (await prompt(page).boundingBox())!;
  const originalHeader = (await page.locator('.canvas-topbar').boundingBox())!;
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(2);
  await inViewport(page, panel(page));
  await expect(page.getByRole('separator', { name: 'Resize research sidebar', exact: true })).toHaveCount(0);
  const floatingWidth = (await panel(page).boundingBox())!.width;
  expect(floatingWidth).toBeLessThan(520);
  expect(await prompt(page).boundingBox()).toEqual(originalBounds);
  expect(await page.locator('.canvas-topbar').boundingBox()).toEqual(originalHeader);
  expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);
  // A click on empty canvas dismisses without a separate close-button trip.
  await page.mouse.click(page.viewportSize()!.width - 24, 110);
  await expect(panel(page)).not.toBeVisible();
  expect(await prompt(page).boundingBox()).toEqual(originalBounds);
  await expect(prompt(page)).toHaveValue('My question stays still when I browse earlier research.');
  await openLibrary(page);
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await inViewport(page, panel(page));
  expect((await panel(page).boundingBox())!.width).toBe(floatingWidth);
});

test('outside controls receive the first click while the library closes', async ({ page }) => {
  const brain = await mockBrain(page);
  await page.goto('/');
  await prompt(page).fill('Continue this question');
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(2);
  await prompt(page).click();
  await expect(panel(page)).not.toBeVisible();
  await expect(prompt(page)).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' without another click.');
  await expect(prompt(page)).toHaveValue('Continue this question without another click.');
  await openLibrary(page);
  const connection = page.getByRole('button', { name: /^Model connection:/ });
  await connection.click();
  await expect(panel(page)).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Model connection check', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(connection).toBeFocused();
  expect(brain.writes.filter((write) => write.path.startsWith('/jobs'))).toEqual([]);
  expect(brain.unhandled).toEqual([]);
});

test('rail toggles and switches the floating library while search and pagination survive dismissal', async ({ page }) => {
  await mockBrain(page, { jobs: Array.from({ length: 120 }, (_, index) => makeJob(index)), trash: [makeJob(200, { title: 'Archived experiment', trashedAt: Date.now(), status: 'cancelled' })] });
  await page.goto('/');
  await openLibrary(page);
  await panel(page).getByRole('textbox', { name: 'Search research history', exact: true }).fill('Research record');
  await expect(rows(page)).toHaveCount(50);
  await panel(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel(page).getByRole('navigation', { name: 'History pages', exact: true })).toContainText('51–100 of 120');
  await page.locator('#sidebar-trash-trigger').click();
  await expect(panel(page).getByRole('textbox', { name: 'Search trash', exact: true })).toBeVisible();
  await panel(page).getByRole('textbox', { name: 'Search trash', exact: true }).fill('Archived');
  await page.locator('#sidebar-trash-trigger').click();
  await expect(panel(page)).not.toBeVisible();
  await expect(page.locator('#sidebar-trash-trigger')).toHaveAttribute('aria-expanded', 'false');
  await openLibrary(page);
  await expect(panel(page).getByRole('textbox', { name: 'Search research history', exact: true })).toHaveValue('Research record');
  await expect(panel(page).getByRole('navigation', { name: 'History pages', exact: true })).toContainText('51–100 of 120');
  await page.locator('#sidebar-history-trigger').click();
  await expect(panel(page)).not.toBeVisible();
  await openLibrary(page, 'trash');
  await expect(panel(page).getByRole('textbox', { name: 'Search trash', exact: true })).toHaveValue('Archived');
});

test('ten thousand summaries stay bounded, searchable and independent of the main draft', async ({ page }) => {
  const brain = await mockBrain(page, { jobs: Array.from({ length: 10_000 }, (_, index) => makeJob(index)) });
  await page.goto('/');
  await prompt(page).fill('Keep this question while I find one record.');
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(50);
  const detailRequests = () => brain.requests.filter((request) => /^\/jobs\/(?!trash$)[^/]+$/.test(request.path));
  expect(detailRequests()).toHaveLength(0);
  await panel(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel(page).getByRole('navigation', { name: 'History pages', exact: true })).toContainText('51–100 of 10,000');
  await panel(page).getByRole('textbox', { name: 'Search research history', exact: true }).fill('Research record 9999');
  await expect(rows(page)).toHaveCount(1);
  await expect(prompt(page)).toHaveValue('Keep this question while I find one record.');
  expect(detailRequests()).toHaveLength(0);
  await panel(page).getByRole('link', { name: 'Open research: Research record 9999', exact: true }).click();
  await expect(page.locator('.dash-title')).toHaveText('Research record 9999');
  await expect.poll(() => detailRequests().length).toBe(1);
});

test('trash can be searched and opened as a read-only run', async ({ page }) => {
  const brain = await mockBrain(page, { trash: [makeJob(80, { title: 'Archived hypothesis', status: 'cancelled', trashedAt: Date.now() }), makeJob(81, { title: 'Earlier experiment', status: 'cancelled', trashedAt: Date.now() })] });
  await page.goto('/');
  await openLibrary(page, 'trash');
  await panel(page).getByRole('textbox', { name: 'Search trash', exact: true }).fill('Archived hypothesis');
  await expect(rows(page)).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: /^Actions for / })).toHaveCount(0);
  await panel(page).getByRole('link', { name: 'Open research: Archived hypothesis', exact: true }).click();
  await expect(page.locator('.dash-title')).toHaveText('Archived hypothesis');
  await expect(page.getByText('in trash — view-only; files remain on disk', { exact: true })).toBeVisible();
  await expect(page.locator('.dash-actions button')).toHaveCount(0);
  expect(brain.writes.filter((write) => write.path.startsWith('/jobs'))).toEqual([]);
});

test('a failed trash request is recoverable without disturbing the current work', async ({ page }) => {
  const brain = await mockBrain(page, { trash: [makeJob(80, { title: 'Recovered archive', status: 'cancelled', trashedAt: Date.now() })] });
  brain.failTrash = 'Archive storage is temporarily unavailable.';
  await page.goto('/');
  await prompt(page).fill('Keep this question through a list failure.');
  await openLibrary(page, 'trash');
  await expect(panel(page).getByRole('alert')).toContainText('Archive storage is temporarily unavailable.');
  brain.failTrash = false;
  await panel(page).getByRole('button', { name: 'Retry loading trash', exact: true }).click();
  await expect(panel(page).getByRole('link', { name: 'Open research: Recovered archive', exact: true })).toBeVisible();
  await expect(prompt(page)).toHaveValue('Keep this question through a list failure.');
  expect(brain.writes.filter((write) => write.path.startsWith('/jobs'))).toEqual([]);
});

test('a mobile row menu dismisses before the library and keeps destructive actions explicit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const brain = await mockBrain(page, { jobs: [makeJob(1, { status: 'cancelled' })] });
  await page.goto('/');
  await openLibrary(page);
  const actions = panel(page).getByRole('button', { name: 'Actions for Research record 1', exact: true });
  await actions.click();
  await expect(page.getByRole('menu', { name: 'Actions for Research record 1', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Actions for Research record 1', exact: true })).not.toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(actions).toBeFocused();
  await actions.click();
  await page.getByRole('menuitem', { name: 'Move to trash', exact: true }).click();
  await expect(panel(page).getByRole('group', { name: 'Move to trash confirmation', exact: true })).toBeVisible();
  expect(brain.writes.filter((write) => write.path.startsWith('/jobs'))).toEqual([]);
  await panel(page).getByRole('button', { name: 'Keep run', exact: true }).click();
  await expect(panel(page).getByRole('group', { name: 'Move to trash confirmation', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel(page)).not.toBeVisible();
});

test('legacy history and trash hashes preserve an existing research view', async ({ page }) => {
  await mockBrain(page);
  await page.goto('/#/history');
  await expect(panel(page)).toBeVisible();
  await expect(prompt(page)).toBeVisible();
  await panel(page).getByRole('link', { name: 'Open research: Research record 1', exact: true }).click();
  // The loading skeleton also uses .dash; capture the loaded research view.
  await expect(page.locator('.dash-title')).toHaveText('Research record 1');
  const dashboard = await page.locator('.dash').elementHandle();
  await page.evaluate(() => { location.hash = '#/trash'; });
  await expect(panel(page).getByRole('textbox', { name: 'Search trash', exact: true })).toBeVisible();
  await expect(page.locator('.dash-title')).toHaveText('Research record 1');
  expect(await dashboard!.evaluate((element) => element.isConnected)).toBe(true);
  await page.evaluate(() => { location.hash = '#/history'; });
  await expect(panel(page).getByRole('textbox', { name: 'Search research history', exact: true })).toBeVisible();
  expect(await dashboard!.evaluate((element) => element.isConnected)).toBe(true);
});

test('browser Back and Forward restore job, stage and floating panel snapshots', async ({ page }) => {
  await mockBrain(page);
  await page.goto('/#/jobs/test-run-1/stage/first-pass');
  await expect(page.locator('.dash-title')).toHaveText('Research record 1');
  await openLibrary(page);
  await expect(page).toHaveURL(/#\/jobs\/test-run-1\/stage\/first-pass\?panel=history$/);
  await panel(page).getByRole('link', { name: 'Open research: Research record 2', exact: true }).click();
  await expect(page.locator('.dash-title')).toHaveText('Research record 2');
  await expect(page).toHaveURL(/#\/jobs\/test-run-2$/);
  await expect(panel(page)).not.toBeVisible();
  await openLibrary(page, 'trash');
  await expect(page).toHaveURL(/#\/jobs\/test-run-2\?panel=trash$/);
  await page.goBack();
  await expect(panel(page)).not.toBeVisible();
  await expect(page.locator('.dash-title')).toHaveText('Research record 2');
  await page.goBack();
  await expect(page).toHaveURL(/#\/jobs\/test-run-1\/stage\/first-pass\?panel=history$/);
  await expect(page.locator('.dash-title')).toHaveText('Research record 1');
  await expect(panel(page).getByRole('link', { name: 'Open research: Research record 1', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL(/#\/jobs\/test-run-1\/stage\/first-pass$/);
  await expect(panel(page)).not.toBeVisible();
  await page.goForward();
  await expect(panel(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/jobs\/test-run-1\/stage\/first-pass\?panel=history$/);
  await page.goForward();
  await expect(page.locator('.dash-title')).toHaveText('Research record 2');
  await expect(panel(page)).not.toBeVisible();
  await page.goForward();
  await expect(panel(page).getByRole('textbox', { name: 'Search trash', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/jobs\/test-run-2\?panel=trash$/);
});

test('desktop to phone and back preserves the library without blocking the workspace or rail', async ({ page }) => {
  await mockBrain(page);
  await page.goto('/');
  await prompt(page).fill('A draft that survives rotating or moving the window.');
  await openLibrary(page);
  await panel(page).getByRole('textbox', { name: 'Search research history', exact: true }).fill('record 1');
  await expect(rows(page)).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel(page)).not.toHaveAttribute('aria-modal', 'true');
  await inViewport(page, panel(page));
  const backgroundInert = () => page.locator('.canvas-home textarea').evaluate((element) => {
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  });
  await expect.poll(backgroundInert).toBe(false);
  await expect(panel(page).getByRole('textbox', { name: 'Search research history', exact: true })).toHaveValue('record 1');
  await page.locator('#sidebar-trash-trigger').click();
  await expect(panel(page).getByRole('textbox', { name: 'Search trash', exact: true })).toBeVisible();
  await page.locator('#sidebar-history-trigger').click();
  await expect(panel(page).getByRole('textbox', { name: 'Search research history', exact: true })).toHaveValue('record 1');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await inViewport(page, panel(page));
  await expect.poll(backgroundInert).toBe(false);
  await expect(prompt(page)).toHaveValue('A draft that survives rotating or moving the window.');
  await prompt(page).click();
  await expect(prompt(page)).toBeFocused();
  await expect(panel(page)).not.toBeVisible();
});

test.describe('touch input', () => {
  test.use({ hasTouch: true });

  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    test(`library taps avoid opening the keyboard and leave navigation accessible at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockBrain(page);
      await page.goto('/');
      const trigger = page.locator('#sidebar-history-trigger');
      await trigger.tap();
      await expect(rows(page)).toHaveCount(2);
      await expect(panel(page)).toBeFocused();
      const search = panel(page).getByRole('textbox', { name: 'Search research history', exact: true });
      await expect(search).not.toBeFocused();
      await page.keyboard.press('Control+k');
      await expect(search).toBeFocused();
      await search.fill('record 1');
      await page.getByRole('link', { name: 'New research', exact: true }).tap();
      await expect(panel(page)).not.toBeVisible();
      await expect(prompt(page)).toBeFocused();
      await trigger.tap();
      await expect(search).toHaveValue('record 1');
      await expect(search).not.toBeFocused();
      await page.touchscreen.tap(viewport.width - 4, 110);
      await expect(panel(page)).not.toBeVisible();
    });
  }
});

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1080, height: 1920 }, { width: 3440, height: 1440 }]) {
  test(`library is usable at ${viewport.width}×${viewport.height} with correct dismissal and selection`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockBrain(page);
    await page.goto('/');
    await prompt(page).fill('Keep this portrait and landscape draft.');
    const trigger = page.locator('#sidebar-history-trigger');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(2);
    await inViewport(page, panel(page));
    await inViewport(page, panel(page).getByRole('textbox', { name: 'Search research history', exact: true }));
    await expect(panel(page)).not.toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
    await expect(panel(page)).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(prompt(page)).toHaveValue('Keep this portrait and landscape draft.');
    await trigger.click();
    // New research must collapse the library even when the home is already open.
    await page.getByRole('link', { name: 'New research', exact: true }).click();
    await expect(panel(page)).not.toBeVisible();
    await expect(prompt(page)).toBeFocused();
    await expect(prompt(page)).toHaveValue('Keep this portrait and landscape draft.');
    await openLibrary(page);
    await panel(page).getByRole('link', { name: 'Open research: Research record 1', exact: true }).click();
    await expect(page.locator('.dash-title')).toHaveText('Research record 1');
    await expect(panel(page)).not.toBeVisible();
    await openLibrary(page);
    await page.getByRole('link', { name: 'New research', exact: true }).click();
    await expect(prompt(page)).toHaveValue('Keep this portrait and landscape draft.');
    await expect(prompt(page)).toBeFocused();
    await expect(panel(page)).not.toBeVisible();
  });
}
