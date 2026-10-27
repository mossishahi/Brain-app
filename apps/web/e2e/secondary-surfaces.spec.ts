import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockBrain } from "./fixtures";

async function withinViewport(page: Page, surface: Locator): Promise<void> {
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function checkFilePicker(page: Page): Promise<void> {
  const brain = await mockBrain(page);
  await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "What do you want to think through?", exact: true });
  await prompt.fill("Keep this draft while choosing a server reference.");
  const trigger = page.getByRole("button", { name: "Attach from server", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: /PDF files/ }).click();
  const dialog = page.getByRole("dialog", { name: /Select PDF files/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("reference.pdf", { exact: true })).toBeVisible();
  // Ant's entrance scale can temporarily hide an oversized dialog. Check the
  // settled layout so a footer below the viewport cannot produce a false pass.
  await expect(dialog).not.toHaveClass(/ant-zoom-(?:appear|enter)/);
  await expect(dialog).toHaveCSS("transform", "none");
  await withinViewport(page, dialog);
  await withinViewport(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
  const attach = dialog.getByRole("button", { name: "Validate & attach", exact: true });
  await withinViewport(page, attach);
  await expect(attach).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(prompt).toHaveValue("Keep this draft while choosing a server reference.");
  expect(brain.unhandled).toEqual([]);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`environment details fit ${viewport.width}×${viewport.height} and restore keyboard focus`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const brain = await mockBrain(page);
    brain.readiness = { ready: false, updatedAt: Date.now(), checks: [{
      id: "llm", label: "Model connection", required: true, state: "failed",
      message: "Connection requires attention", detail: "Long provider diagnostic detail\n".repeat(30),
      advice: "Verify the provider settings and connection before retrying. ".repeat(8),
    }] };
    await page.goto("/");
    const trigger = page.getByRole("button", { name: /^Model connection: failed/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const popup = page.getByRole("dialog", { name: "Model connection check", exact: true });
    await expect(popup).toBeVisible();
    await withinViewport(page, popup);
    await expect.poll(() => popup.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await popup.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await expect(popup).toHaveCount(0);
  });

  test(`server file picker fits ${viewport.width}×${viewport.height} with reachable actions`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await checkFilePicker(page);
  });
}

test('server file picker fits 1440×900 with reachable actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkFilePicker(page);
});

test.describe('coarse-pointer phone', () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  test('server file picker fits 320×740 with reachable actions', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await checkFilePicker(page);
  });
});

test('history navigation dismisses portaled connection details while preserving the home draft', async ({ page }) => {
  await mockBrain(page);
  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'What do you want to think through?', exact: true });
  await prompt.fill('Continue this question after checking history.');
  await page.getByRole('button', { name: /^Model connection:/ }).click();
  const popup = page.getByRole('dialog', { name: 'Model connection check', exact: true });
  await expect(popup).toBeVisible();
  // Browser navigation does not click outside the popup: the owning view must close it.
  await page.evaluate(() => { location.hash = '#/history'; });
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Research library', exact: true })).toBeVisible();
  await expect(prompt).toHaveValue('Continue this question after checking history.');
});
