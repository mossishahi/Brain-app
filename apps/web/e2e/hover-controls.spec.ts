import { expect, test, type Locator, type Page } from '@playwright/test';
import { defaultTestSettings, makeJob, mockBrain } from './fixtures';

const question = (page: Page) => page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });
const library = (page: Page) => page.getByRole('complementary', { name: 'Research library', exact: true });
const settingsMenu = (page: Page) => page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Research', exact: true }) });
const attachmentMenu = (page: Page) => page.getByRole('menu', { name: 'Attach from server', exact: true });

async function openHome(page: Page) {
  const settings = defaultTestSettings();
  const brain = await mockBrain(page, { settings: { ...settings, runner: 'slurm' }, trash: [makeJob(80, { title: 'Archived hypothesis', trashedAt: Date.now(), status: 'cancelled' })] });
  brain.readiness = { ready: true, updatedAt: Date.now(), checks: [
    { id: 'llm', label: 'Model connection', required: true, state: 'ok', message: 'Ready' },
    { id: 'slurm', label: 'SLURM scheduler', required: true, state: 'ok', message: 'Scheduler ready' },
  ] };
  await page.addInitScript(() => localStorage.setItem('brain.appearance.v1', JSON.stringify({ version: 1, preferences: { background: 'none', theme: 'dark' } })));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(question(page)).toBeVisible();
  await question(page).fill('Keep typing while browsing nearby controls.');
  return brain;
}

async function outside(page: Page) {
  await page.mouse.move(page.viewportSize()!.width - 8, 8);
}

/** Spend time in the actual empty gap, not an instantaneous jump to the popup. */
async function crossGap(page: Page, trigger: Locator, popup: Locator) {
  const from = (await trigger.boundingBox())!;
  const to = (await popup.boundingBox())!;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  let x: number;
  let y: number;
  if (to.x >= from.x + from.width) {
    x = (from.x + from.width + to.x) / 2;
    y = clamp(from.y + from.height / 2, to.y + 10, to.y + to.height - 10);
  } else if (to.x + to.width <= from.x) {
    x = (to.x + to.width + from.x) / 2;
    y = clamp(from.y + from.height / 2, to.y + 10, to.y + to.height - 10);
  } else {
    x = clamp(from.x + from.width / 2, to.x + 10, to.x + to.width - 10);
    y = to.y >= from.y + from.height ? (from.y + from.height + to.y) / 2 : (to.y + to.height + from.y) / 2;
  }
  await page.mouse.move(x, y);
  await page.waitForTimeout(80);
  await expect(popup).toBeVisible();
  await popup.hover({ position: { x: 12, y: 12 } });
  await expect(popup).toBeVisible();
}

function noUserWrites(brain: Awaited<ReturnType<typeof mockBrain>>) {
  expect(brain.writes.filter(write => /^(\/jobs|\/settings|\/readiness\/(check|diagnose)|\/attachments\/validate)/.test(write.path))).toEqual([]);
}

test('library hover preserves typing focus, bridges to the panel, switches lists and dismisses on leave or Escape', async ({ page }) => {
  const brain = await openHome(page);
  const history = page.locator('#sidebar-history-trigger');
  const trash = page.locator('#sidebar-trash-trigger');
  const draft = await question(page).inputValue();
  const historyLength = await page.evaluate(() => history.length);
  await history.hover();
  await expect(library(page)).toBeVisible();
  await expect(library(page).locator('.library-row')).toHaveCount(2);
  await expect(question(page)).toBeFocused();
  await crossGap(page, history, library(page));
  await expect(question(page)).toBeFocused();
  const actions = library(page).getByRole('button', { name: 'Actions for Research record 1', exact: true });
  await actions.hover();
  const actionMenu = page.getByRole('menu', { name: 'Actions for Research record 1', exact: true });
  await expect(actionMenu).toBeVisible();
  await crossGap(page, actions, actionMenu);
  await actionMenu.getByRole('menuitem', { name: 'Move to trash', exact: true }).hover();
  await expect(library(page)).toBeVisible();
  await expect(question(page)).toBeFocused();
  await expect(library(page).getByRole('group', { name: 'Move to trash confirmation', exact: true })).toHaveCount(0);
  await trash.hover();
  await expect(library(page).getByRole('textbox', { name: 'Search trash', exact: true })).toBeVisible();
  await expect(library(page).getByRole('link', { name: 'Open research: Archived hypothesis', exact: true })).toBeVisible();
  await expect(question(page)).toBeFocused();
  await outside(page);
  await expect(library(page)).not.toBeVisible();
  await expect(question(page)).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await history.hover();
  await expect(library(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(library(page)).not.toBeVisible();
  await expect(question(page)).toBeFocused();
  await outside(page);
  await history.hover();
  await expect(library(page)).toBeVisible();
  // An explicit click after hover enters search, rather than closing the preview.
  await history.click();
  await expect(library(page).getByRole('textbox', { name: 'Search research history', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(library(page)).not.toBeVisible();
  await expect(question(page)).toHaveValue(draft);
  noUserWrites(brain);
});

test('a pending library hover cannot reopen over a newer New research action', async ({ page }) => {
  await openHome(page);
  await page.locator('#sidebar-history-trigger').hover();
  await page.getByRole('link', { name: 'New research', exact: true }).click();
  // The leave grace period also exceeds the 160ms pending-open delay.
  await page.waitForTimeout(260);
  await expect(library(page)).not.toBeVisible();
  await expect(page.locator('#sidebar-history-trigger')).toHaveAttribute('aria-expanded', 'false');
  await expect(question(page)).toBeFocused();
});

test('settings hover opens nested tiers without changing preferences or taking typing focus', async ({ page }) => {
  const brain = await openHome(page);
  const trigger = page.getByRole('button', { name: 'Open settings menu', exact: true });
  await trigger.hover();
  await expect(settingsMenu(page)).toBeVisible();
  await expect(question(page)).toBeFocused();
  await crossGap(page, trigger, settingsMenu(page));
  const research = page.getByRole('menuitem', { name: 'Research', exact: true });
  await research.hover();
  const researchMenu = page.getByRole('menu', { name: 'Research', exact: true });
  await expect(researchMenu).toBeVisible();
  await crossGap(page, research, researchMenu);
  const countdown = page.getByRole('menuitemcheckbox', { name: 'Continue after countdown', exact: true });
  await countdown.hover();
  await expect(countdown).toBeChecked();
  const rounds = page.getByRole('menuitem', { name: 'Review rounds', exact: true });
  await rounds.hover();
  const roundMenu = page.getByRole('menu', { name: 'Review rounds', exact: true });
  await expect(roundMenu).toBeVisible();
  await crossGap(page, rounds, roundMenu);
  await page.getByRole('menuitemradio', { name: '4 rounds', exact: true }).hover();
  await expect(page.getByRole('menuitemradio', { name: '3 rounds', exact: true })).toBeChecked();
  await expect(question(page)).toBeFocused();
  await page.keyboard.type(' More context.');
  await expect(question(page)).toHaveValue('Keep typing while browsing nearby controls. More context.');
  noUserWrites(brain);
  await outside(page);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.hover();
  await expect(settingsMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('attachment hover preserves the draft and tolerates crossing the popup gap', async ({ page }) => {
  const brain = await openHome(page);
  const attach = page.getByRole('button', { name: 'Attach from server', exact: true });
  await attach.hover();
  await expect(attachmentMenu(page)).toBeVisible();
  await expect(question(page)).toBeFocused();
  await crossGap(page, attach, attachmentMenu(page));
  await attachmentMenu(page).getByRole('menuitem', { name: /Web URL/ }).hover();
  await expect(page.getByRole('textbox', { name: 'web URL attachment', exact: true })).toHaveCount(0);
  await expect(question(page)).toBeFocused();
  await page.keyboard.type(' More context.');
  await expect(question(page)).toHaveValue('Keep typing while browsing nearby controls. More context.');
  await outside(page);
  await expect(attachmentMenu(page)).not.toBeVisible();
  await attach.hover();
  await expect(attachmentMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(attachmentMenu(page)).not.toBeVisible();
  noUserWrites(brain);
});

test('status hover previews preserve typing focus and remain open across the popup gap', async ({ page }) => {
  const brain = await openHome(page);
  for (const name of ['Model connection', 'SLURM scheduler']) {
    const trigger = page.getByRole('button', { name: new RegExp(`^${name}:`) });
    const popup = page.getByRole('dialog', { name: `${name} check`, exact: true });
    await trigger.hover();
    await expect(popup).toBeVisible();
    await expect(question(page)).toBeFocused();
    await crossGap(page, trigger, popup);
    await expect(question(page)).toBeFocused();
    await outside(page);
    await expect(popup).not.toBeVisible();
  }
  const registry = page.getByRole('link', { name: /^Connected to Brain Registry/ });
  await registry.hover();
  const tooltip = page.locator('.canvas-registry-tooltip');
  await expect(tooltip).toContainText('Connected to Brain Registry');
  await expect(question(page)).toBeFocused();
  await outside(page);
  await expect(tooltip).not.toBeVisible();
  noUserWrites(brain);
});

test('keyboard still opens and closes attachment, settings and connection controls', async ({ page }) => {
  await openHome(page);
  const attach = page.getByRole('button', { name: 'Attach from server', exact: true });
  await attach.focus();
  await page.keyboard.press('Enter');
  await expect(attachmentMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(attachmentMenu(page)).not.toBeVisible();
  await expect(attach).toBeFocused();
  const settings = page.getByRole('button', { name: 'Open settings menu', exact: true });
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(settingsMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsMenu(page)).not.toBeVisible();
  await expect(settings).toBeFocused();
  const connection = page.getByRole('button', { name: /^Model connection:/ });
  await connection.focus();
  await page.keyboard.press('Enter');
  const popup = page.getByRole('dialog', { name: 'Model connection check', exact: true });
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(connection).toBeFocused();
});

test('registry, model, GPU and scheduler stay inside the composer beside Send in compact and multiline layouts', async ({ page }) => {
  await openHome(page);
  await expect(page.getByText('Research, in one place.', { exact: true })).toHaveCount(0);
  for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    for (const multiline of [false, true]) {
      await question(page).fill(multiline ? 'A question across several lines.\nIts evidence needs careful review.\nA third line makes the composer expand.' : 'A short question.');
      if (multiline) await expect(page.locator('.canvas-composer')).toHaveClass(/canvas-composer-expanded/);
      const geometry = await page.locator('.canvas-composer').evaluate((element) => {
        const box = (node: Element) => {
          const bounds = node.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, centerY: bounds.y + bounds.height / 2 };
        };
        const surface = box(element);
        const controls = [...element.querySelectorAll('.registry-indicator, .env-icon, .send-btn')].map(box);
        return { surface, controls, input: box(element.querySelector('textarea')!), viewport: innerWidth, documentWidth: document.documentElement.scrollWidth };
      });
      expect(geometry.controls).toHaveLength(5);
      const send = geometry.controls.at(-1)!;
      for (const [index, control] of geometry.controls.entries()) {
        expect(control.x).toBeGreaterThanOrEqual(geometry.surface.x);
        expect(control.right).toBeLessThanOrEqual(geometry.surface.right);
        expect(control.y).toBeGreaterThanOrEqual(geometry.surface.y);
        expect(control.bottom).toBeLessThanOrEqual(geometry.surface.bottom);
        expect(Math.abs(control.centerY - send.centerY)).toBeLessThan(1);
        if (index > 0) expect(geometry.controls[index - 1]!.right).toBeLessThanOrEqual(control.x + 1);
        if (multiline) expect(control.y).toBeGreaterThanOrEqual(geometry.input.bottom);
      }
      expect(geometry.surface.right).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport + 1);
    }
  }
});

test.describe('touch fallback', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('touch taps open the library, in-place settings tiers, attachments and connection details', async ({ page }) => {
    const brain = await openHome(page);
    const history = page.locator('#sidebar-history-trigger');
    await history.tap();
    await expect(library(page)).toBeVisible();
    await page.locator('#sidebar-trash-trigger').tap();
    await expect(library(page).getByRole('textbox', { name: 'Search trash', exact: true })).toBeVisible();
    await page.locator('#sidebar-trash-trigger').tap();
    await expect(library(page)).not.toBeVisible();
    await page.getByRole('button', { name: 'Open settings menu', exact: true }).tap();
    await page.getByRole('menuitem', { name: 'Research', exact: true }).tap();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Continue after countdown', exact: true })).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(1);
    await page.getByRole('menuitem', { name: 'Back', exact: true }).tap();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Attach from server', exact: true }).tap();
    await expect(attachmentMenu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Model connection:/ }).tap();
    await expect(page.getByRole('dialog', { name: 'Model connection check', exact: true })).toBeVisible();
    noUserWrites(brain);
  });
});
