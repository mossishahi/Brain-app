import type { BackgroundQuality } from "./appearance-model";

const budgets = {
  balanced: { framesPerSecond: 24, maxPixels: 1_600_000, maxDpr: 1.5 },
  low: { framesPerSecond: 12, maxPixels: 650_000, maxDpr: 1 },
} as const;

/** Bound decoration by pixel count, not by an assumption about screen shape. */
export function renderBudget(width: number, height: number, dpr: number, quality: BackgroundQuality) {
  const budget = budgets[quality];
  const valid = (value: number) => Number.isFinite(value) && value > 0;
  const cssWidth = valid(width) ? width : 1;
  const cssHeight = valid(height) ? height : 1;
  const scale = Math.min(valid(dpr) ? dpr : 1, budget.maxDpr,
    Math.sqrt(budget.maxPixels / (cssWidth * cssHeight)));
  return {
    width: Math.max(1, Math.floor(cssWidth * scale)),
    height: Math.max(1, Math.floor(cssHeight * scale)),
    scale,
    frameInterval: 1000 / budget.framesPerSecond,
  };
}
