import { expect, test, type Page } from "@playwright/test";
import { mockBrain } from "./fixtures";

declare global {
  interface Window {
    __backgroundFrames: number;
    __backgroundHidden: boolean;
    __backgroundDocumentToken: string;
  }
}

const canvas = (page: Page) => page.locator(".brain-background-canvas");
const frameCount = (page: Page) => page.evaluate(() => window.__backgroundFrames);

async function instrumentFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__backgroundFrames = 0;
    window.__backgroundDocumentToken = `${Date.now()}-${Math.random()}`;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args: Parameters<typeof clear>) {
      if (this.canvas.classList.contains("brain-background-canvas")) window.__backgroundFrames += 1;
      return clear.apply(this, args);
    };
  });
}

async function openAppearance(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "All settings…", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Animate the background", exact: true })).toBeVisible();
}

async function expectStill(page: Page): Promise<void> {
  // Preference changes are allowed one redraw before the scheduler stops.
  await page.waitForTimeout(120);
  const count = await frameCount(page);
  await page.waitForTimeout(220);
  expect(await frameCount(page)).toBe(count);
}

test.beforeEach(async ({ page }) => {
  await mockBrain(page);
  await instrumentFrames(page);
});

test("appearance controls switch renderers, preserve the prompt, and persist browser choices", async ({ page }) => {
  await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "What do you want to think through?", exact: true });
  await prompt.fill("Keep this research draft while changing appearance.");
  await expect(canvas(page)).toHaveCount(1);
  await openAppearance(page);
  await page.getByRole("radio", { name: /^None\b/ }).check();
  await expect(canvas(page)).toHaveCount(0);
  await page.getByRole("radio", { name: /^Orbit\b/ }).check();
  await expect(canvas(page)).toHaveCount(1);
  await expect(page.locator(".brain-background")).toHaveAttribute("data-background", "orbit");
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByLabel("Animation quality", { exact: true }).selectOption("low");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("brain.appearance.v1")!));
  expect(saved).toEqual({ version: 1, preferences: { theme: "dark", background: "orbit", motion: true, quality: "low" } });
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveValue("Keep this research draft while changing appearance.");
  await prompt.click(); // An animated canvas must never intercept foreground input.
  await expect(prompt).toBeFocused();
  await page.reload();
  await expect(page.locator(".brain-background")).toHaveAttribute("data-background", "orbit");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(canvas(page)).toHaveCount(1);
});

test("motion controls and live OS reduced-motion changes stop frame rendering", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect.poll(() => frameCount(page)).toBeGreaterThan(2);
  await openAppearance(page);
  const motion = page.getByRole("switch", { name: "Animate the background", exact: true });
  await motion.click();
  await expectStill(page);
  await motion.click();
  const resumed = await frameCount(page);
  await expect.poll(() => frameCount(page)).toBeGreaterThan(resumed + 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByText("Your device requests reduced motion, so the background remains still.")).toBeVisible();
  await expectStill(page);
  // Keep the user's motion preference, even while the OS overrides its effect.
  await expect(motion).toBeChecked();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const released = await frameCount(page);
  await expect.poll(() => frameCount(page)).toBeGreaterThan(released + 1);
});

test("visibility events suspend decoration and resume it without remounting", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => frameCount(page)).toBeGreaterThan(2);
  // Headless tabs do not consistently enter the background. Exercise the browser
  // visibility event with its state overridden, rather than freezing JS execution.
  await page.evaluate(() => {
    window.__backgroundHidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__backgroundHidden });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expectStill(page);
  await expect(canvas(page)).toHaveCount(1);
  const hiddenCount = await frameCount(page);
  await page.evaluate(() => {
    window.__backgroundHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => frameCount(page)).toBeGreaterThan(hiddenCount + 1);
  await expect(canvas(page)).toHaveCount(1);
});

test("portrait and ultrawide surfaces respect quality budgets and occupy the viewport", async ({ page }) => {
  await page.goto("/");
  await expect(canvas(page)).toHaveCount(1);
  for (const viewport of [{ width: 320, height: 900 }, { width: 900, height: 320 }, { width: 5120, height: 1440 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => canvas(page).evaluate((element: HTMLCanvasElement) => element.width * element.height)).toBeLessThanOrEqual(1_600_000);
    const bounds = await page.locator(".brain-background").boundingBox();
    expect(bounds).toEqual({ x: 0, y: 0, ...viewport });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAppearance(page);
  await page.getByLabel("Animation quality", { exact: true }).selectOption("low");
  await expect.poll(async () => canvas(page).evaluate((element: HTMLCanvasElement) => element.width * element.height)).toBeLessThanOrEqual(650_000);
});

test("system theme follows the OS and explicit theme stays fixed", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await openAppearance(page);
  await page.getByLabel("Theme", { exact: true }).selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("appearance changes in another tab update the shared preference snapshot", async ({ page, context }) => {
  await page.goto("/");
  await expect(canvas(page)).toHaveCount(1);
  const peer = await context.newPage();
  try {
    await mockBrain(peer);
    await peer.goto("/");
    await openAppearance(peer);
    await peer.getByLabel("Theme", { exact: true }).selectOption("dark");
    await peer.getByRole("radio", { name: /^None\b/ }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(".brain-background")).toHaveAttribute("data-background", "none");
    await expect(canvas(page)).toHaveCount(0);
  } finally {
    await peer.close();
  }
});

test("unavailable storage preserves working appearance controls and reports the failed save", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () { throw new DOMException("Storage is full", "QuotaExceededError"); };
  });
  await page.goto("/");
  await openAppearance(page);
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("These preferences work in this tab, but your browser could not save them for next time.")).toBeVisible();
  await page.getByRole("radio", { name: /^None\b/ }).check();
  await expect(canvas(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("textbox", { name: "What do you want to think through?", exact: true });
  await prompt.fill("Keep this draft when automatic recovery cannot be guarded.");
  await page.evaluate(async () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    Object.assign(event, { payload: new Error("A critical chunk failed with storage unavailable") });
    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await expect(prompt).toHaveValue("Keep this draft when automatic recovery cannot be guarded.");
});

test("critical chunk recovery reloads once and keeps its cross-page loop guard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "What do you want to think through?", exact: true })).toBeVisible();
  const initialDocument = await page.evaluate(() => window.__backgroundDocumentToken);
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate(() => {
      const event = new Event("vite:preloadError", { cancelable: true });
      Object.assign(event, { payload: new Error("A critical chunk is unavailable after deployment") });
      window.dispatchEvent(event);
    }),
  ]);
  const prompt = page.getByRole("textbox", { name: "What do you want to think through?", exact: true });
  await expect(prompt).toBeVisible();
  const recoveredDocument = await page.evaluate(() => window.__backgroundDocumentToken);
  expect(recoveredDocument).not.toBe(initialDocument);
  await prompt.fill("A second failure must not reload this page again.");
  await page.evaluate(async () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    Object.assign(event, { payload: new Error("The critical chunk is still unavailable") });
    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await expect(prompt).toHaveValue("A second failure must not reload this page again.");
  expect(await page.evaluate(() => window.__backgroundDocumentToken)).toBe(recoveredDocument);
});

test("a failed lazy renderer leaves the foreground usable with a plain surface", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("brain.appearance.v1", JSON.stringify({ version: 1, preferences: { background: "none" } }));
  });
  await page.route(/\/(?:src\/backgrounds\/aurora(?:\.ts)?|assets\/aurora-[^/?]+\.js)(?:\?.*)?$/, (route) => route.abort());
  await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "What do you want to think through?", exact: true });
  await prompt.fill("Keep this draft even if the background cannot load.");
  const initialDocument = await page.evaluate(() => window.__backgroundDocumentToken);
  await openAppearance(page);
  await page.getByRole("radio", { name: /^Aurora\b/ }).check();
  await expect(page.locator(".brain-background")).toHaveAttribute("data-background", "none");
  await expect(canvas(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__backgroundDocumentToken)).toBe(initialDocument);
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveValue("Keep this draft even if the background cannot load.");
  await openAppearance(page);
  await page.getByRole("radio", { name: /^Orbit\b/ }).check();
  await expect(canvas(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await prompt.fill("The research interface remains available.");
  await expect(prompt).toHaveValue("The research interface remains available.");
  expect(await page.evaluate(() => window.__backgroundDocumentToken)).toBe(initialDocument);
  expect(errors).toEqual([]);
});

test("a painter failure is contained and releases the canvas", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args: Parameters<typeof clear>) {
      if (this.canvas.classList.contains("brain-background-canvas")) throw new Error("Test decorative painter failure");
      return clear.apply(this, args);
    };
  });
  await page.goto("/");
  await expect(page.locator(".brain-background")).toHaveAttribute("data-background", "none");
  await expect(canvas(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "What do you want to think through?", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
