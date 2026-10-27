import type { BackgroundFrame } from "./canvas-renderer";

export type Color = readonly [number, number, number];
export function rgba(color: Color, opacity: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${opacity})`;
}

/** Translucent light volume without a full-frame blur or additional GPU engine. */
export function glow(
  context: CanvasRenderingContext2D,
  x: number, y: number, radiusX: number, radiusY: number,
  rotation: number, color: Color, opacity: number,
): void {
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.scale(radiusX, radiusY);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, rgba(color, opacity));
  gradient.addColorStop(0.25, rgba(color, opacity * 0.87));
  gradient.addColorStop(0.55, rgba(color, opacity * 0.4));
  gradient.addColorStop(0.8, rgba(color, opacity * 0.1));
  gradient.addColorStop(1, rgba(color, 0));
  context.fillStyle = gradient;
  context.fillRect(-1, -1, 2, 2);
  context.restore();
}

export function drawLightField(
  { context, width, height, time, dark }: BackgroundFrame,
  strength = 1,
): void {
  const centerX = width * 0.53;
  const centerY = height * 0.49;
  // Independent radii preserve a soft field on portrait, ultrawide and small screens.
  const radiusX = Math.min(900, Math.max(width * 0.43, 280));
  const radiusY = Math.min(740, Math.max(height * 0.6, 320));
  const breathe = 1 + Math.sin(time * 0.38) * 0.045;
  const blue: Color = dark ? [57, 102, 215] : [79, 168, 247];
  const cyan: Color = dark ? [38, 140, 173] : [100, 211, 244];
  const violet: Color = dark ? [111, 79, 207] : [162, 151, 236];

  glow(context, centerX, centerY, radiusX * breathe, radiusY, -0.1,
    blue, (dark ? 0.24 : 0.25) * strength);
  glow(context,
    centerX + Math.sin(time * 0.25) * radiusX * 0.18,
    centerY + Math.cos(time * 0.31) * radiusY * 0.17,
    radiusX * 0.8, radiusY * 0.76, Math.sin(time * 0.13) * 0.3,
    cyan, (dark ? 0.15 : 0.23) * strength);
  glow(context,
    centerX + Math.cos(time * 0.2 + 1.8) * radiusX * 0.32,
    centerY + Math.sin(time * 0.28 + 0.5) * radiusY * 0.23,
    radiusX * 0.7, radiusY * 0.72, -0.48 + Math.sin(time * 0.18) * 0.22,
    violet, (dark ? 0.21 : 0.16) * strength);
  glow(context,
    centerX + Math.sin(time * 0.33 + 2.4) * radiusX * 0.31,
    centerY + Math.cos(time * 0.23 + 1.1) * radiusY * 0.3,
    radiusX * 0.64, radiusY * 0.6, 0.4,
    blue, (dark ? 0.16 : 0.19) * strength);
}
