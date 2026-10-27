import { expect, test, type Page } from '@playwright/test';
import { defaultTestSettings, mockBrain } from './fixtures';

const approval = (page: Page) => page.getByRole('menuitemcheckbox', { name: 'Ask me before approval', exact: true });
const countdown = (page: Page) => page.getByRole('menuitemcheckbox', { name: 'Continue after countdown', exact: true });
const item = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });
const pausedExplanation = 'Automatic approval is paused. Enable “Continue after countdown” to use it for new research.';

function settingsWithManualApprovalAndNoCountdown() {
  const settings = defaultTestSettings();
  settings.panelConfirmation = 'manual';
  settings.gateAutoApprove = false;
  return settings;
}

async function openResearchMenu(page: Page) {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await item(page, 'Research').click();
  await expect(approval(page)).toBeVisible();
}

async function openResearchSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings menu', exact: true }).click();
  await item(page, 'All settings…').click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Research', exact: true }).click();
  return dialog;
}

test('approval preference switches both ways while the independent countdown remains off', async ({ page }) => {
  const brain = await mockBrain(page, { settings: settingsWithManualApprovalAndNoCountdown() });
  await page.goto('/');
  await openResearchMenu(page);
  await expect(approval(page)).toBeChecked();
  await expect(countdown(page)).not.toBeChecked();
  await expect(item(page, 'Panel confirmation')).toHaveCount(0);

  await approval(page).click();
  await expect.poll(() => brain.settings.panelConfirmation).toBe('auto');
  await expect(approval(page)).not.toBeChecked();
  await expect(approval(page)).toBeEnabled();
  await expect(page.getByRole('menu', { name: 'Research', exact: true })).toContainText(pausedExplanation);
  await expect(countdown(page)).not.toBeChecked();
  expect(brain.settings.gateAutoApprove).toBe(false);

  await approval(page).click();
  await expect.poll(() => brain.settings.panelConfirmation).toBe('manual');
  await expect(approval(page)).toBeChecked();
  await expect(page.getByRole('menu', { name: 'Research', exact: true })).not.toContainText(pausedExplanation);
  await expect(countdown(page)).not.toBeChecked();
  await expect(page.getByRole('menu')).toHaveCount(2);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  expect(brain.settings.gateAutoApprove).toBe(false);
  expect(brain.writes.filter(write => write.path === '/settings').map(write => write.body)).toEqual([
    { panelConfirmation: 'auto' },
    { panelConfirmation: 'manual' },
  ]);
  expect(brain.unhandled).toEqual([]);
});

test('failed approval saves restore the previous switch state without changing the countdown', async ({ page }) => {
  const brain = await mockBrain(page, { settings: settingsWithManualApprovalAndNoCountdown() });
  await page.goto('/');
  await openResearchMenu(page);
  brain.failSettings = 'Approval preference could not be saved.';
  await approval(page).click();
  await expect(approval(page)).toContainText('Approval preference could not be saved.');
  await expect(approval(page)).toBeChecked();
  await expect(countdown(page)).not.toBeChecked();
  await expect(approval(page)).toBeEnabled();
  expect(brain.settings.panelConfirmation).toBe('manual');
  expect(brain.settings.gateAutoApprove).toBe(false);
  expect(brain.writes.filter(write => write.path === '/settings').map(write => write.body)).toEqual([{ panelConfirmation: 'auto' }]);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
});

test('Settings and quick controls show the same approval preference after edits from either surface', async ({ page }) => {
  const brain = await mockBrain(page, { settings: settingsWithManualApprovalAndNoCountdown() });
  await page.goto('/');
  const dialog = await openResearchSettings(page);
  const settingsApproval = dialog.getByRole('switch', { name: 'Ask me before approval', exact: true });
  await expect(settingsApproval).toBeChecked();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await settingsApproval.click();
  await expect.poll(() => brain.settings.panelConfirmation).toBe('auto');
  await expect(settingsApproval).not.toBeChecked();
  await expect(dialog).toContainText(pausedExplanation);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await openResearchMenu(page);
  await expect(approval(page)).not.toBeChecked();
  await expect(countdown(page)).not.toBeChecked();
  await approval(page).click();
  await expect.poll(() => brain.settings.panelConfirmation).toBe('manual');
  await expect(approval(page)).toBeChecked();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const reopened = await openResearchSettings(page);
  await expect(reopened.getByRole('switch', { name: 'Ask me before approval', exact: true })).toBeChecked();
  await expect(reopened.getByRole('switch', { name: 'Continue after countdown', exact: true })).not.toBeChecked();
  await expect(reopened).not.toContainText(pausedExplanation);
  expect(brain.settings.gateAutoApprove).toBe(false);
  expect(brain.writes.filter(write => write.path === '/settings').map(write => write.body)).toEqual([
    { panelConfirmation: 'auto' },
    { panelConfirmation: 'manual' },
  ]);
});

test.describe('phone approval preference', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the preference is a direct switch without a further menu tier or Settings dialog', async ({ page }) => {
    const brain = await mockBrain(page, { settings: settingsWithManualApprovalAndNoCountdown() });
    await page.goto('/');
    await openResearchMenu(page);
    await expect(page.getByRole('menu')).toHaveCount(1);
    await expect(item(page, 'Back')).toBeVisible();
    await approval(page).tap();
    await expect.poll(() => brain.settings.panelConfirmation).toBe('auto');
    await expect(approval(page)).not.toBeChecked();
    await expect(countdown(page)).not.toBeChecked();
    await expect(page.getByRole('menu')).toHaveCount(1);
    await expect(page.getByRole('menu')).toContainText(pausedExplanation);
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
    await item(page, 'Back').tap();
    await expect(item(page, 'Research')).toBeVisible();
    expect(brain.settings.gateAutoApprove).toBe(false);
    expect(brain.writes.filter(write => write.path === '/settings').map(write => write.body)).toEqual([{ panelConfirmation: 'auto' }]);
  });
});
