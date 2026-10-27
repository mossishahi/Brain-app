import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  readAppearance,
  serializeAppearance,
} from "../src/backgrounds/appearance-model.js";
import { renderBudget } from "../src/backgrounds/render-budget.js";

test("appearance migrates an existing theme without turning it into a system override", () => {
  assert.equal(readAppearance(null, "dark").theme, "dark");
  assert.equal(readAppearance(null, "light").theme, "light");
  assert.equal(readAppearance(null, "invalid").theme, "system");
  const saved = serializeAppearance({ ...DEFAULT_APPEARANCE, theme: "system" });
  assert.equal(readAppearance(saved, "dark").theme, "system");
});

test("malformed or future persisted data cannot install unknown backgrounds or corrupt choices", () => {
  for (const invalid of ["{", "null", "[]", '"dark"', '{"version":2,"preferences":{"theme":"dark"}}']) {
    assert.deepEqual(readAppearance(invalid), DEFAULT_APPEARANCE);
  }
  assert.deepEqual(readAppearance(JSON.stringify({ version: 1, preferences: {
    theme: "ultraviolet", background: "https://example.org/remote.js", motion: "false", quality: "infinite",
  } })), DEFAULT_APPEARANCE);
  assert.deepEqual(readAppearance(JSON.stringify({ version: 1, preferences: {
    theme: "dark", background: "orbit", motion: false, quality: "low",
  } })), { theme: "dark", background: "orbit", motion: false, quality: "low" });
});

test("appearance changes preserve other choices and persist only whitelisted fields", () => {
  const current = { ...DEFAULT_APPEARANCE, background: "orbit" as const, quality: "low" as const };
  const patched = normalizeAppearance({ motion: false, apiKey: "never-persist-this" }, current);
  assert.deepEqual(patched, { ...current, motion: false });
  const serialized = serializeAppearance({ ...patched, extra: "never-persist-this" } as typeof patched);
  assert.equal(serialized.includes("never-persist-this"), false);
  assert.deepEqual(readAppearance(serialized), patched);
});

test("background backing surfaces stay within budget across common display ratios", () => {
  for (const [width, height] of [[320, 900], [900, 320], [5120, 1440], [3840, 2160], [1080, 3840]]) {
    for (const quality of ["low", "balanced"] as const) {
      const budget = renderBudget(width, height, 3, quality);
      assert.ok(budget.width * budget.height <= (quality === "low" ? 650_000 : 1_600_000));
      assert.ok(budget.width > 0 && budget.height > 0);
      assert.ok(budget.frameInterval >= 1000 / (quality === "low" ? 12 : 24));
      // Rounding at the backing pixel boundary is the only allowed aspect change.
      assert.ok(Math.abs(budget.width - width * budget.scale) < 1);
      assert.ok(Math.abs(budget.height - height * budget.scale) < 1);
    }
  }
});

test("a detached or malformed viewport cannot allocate a non-finite canvas", () => {
  for (const size of [0, -1, NaN, Infinity]) {
    const budget = renderBudget(size, size, size, "balanced");
    assert.equal(budget.width, 1);
    assert.equal(budget.height, 1);
    assert.ok(Number.isFinite(budget.scale));
  }
});
