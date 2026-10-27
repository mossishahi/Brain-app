import { canvasRenderer } from "./canvas-renderer";
import { drawLightField, glow, rgba, type Color } from "./light-field";

export const mountOrbit = canvasRenderer((frame) => {
  drawLightField(frame, 0.42);
  const { context, width, height, time, dark } = frame;
  const centerX = width * 0.53;
  const centerY = height * 0.5;
  const radius = Math.min(width * 0.42, height * 0.59, 730);
  const line: Color = dark ? [130, 160, 225] : [117, 149, 189];

  for (let index = 0; index < 9; index += 1) {
    const radiusX = radius * (0.79 + index * 0.062);
    const radiusY = radius * (0.44 + index * 0.045);
    const rotation = -0.42 + Math.sin(time * 0.12 + index * 0.3) * 0.08;
    context.save();
    context.translate(centerX, centerY);
    context.rotate(rotation);
    const ink = context.createLinearGradient(-radiusX, -radiusY, radiusX, radiusY);
    ink.addColorStop(0, rgba(line, 0));
    ink.addColorStop(0.24, rgba(line, dark ? 0.14 : 0.13));
    ink.addColorStop(0.64, rgba(line, dark ? 0.25 : 0.22));
    ink.addColorStop(1, rgba(line, 0));
    context.strokeStyle = ink;
    context.lineWidth = index % 3 === 0 ? 0.85 : 0.55;
    context.beginPath();
    const phase = Math.sin(time * 0.16 + index * 0.32) * 0.17;
    context.ellipse(0, 0, radiusX, radiusY, 0,
      -Math.PI * 0.2 + phase, Math.PI * 1.76 + phase);
    context.stroke();
    if (index === 1 || index === 5 || index === 8) {
      const angle = time * (0.13 + index * 0.008) + index * 1.32;
      const x = Math.cos(angle) * radiusX;
      const y = Math.sin(angle) * radiusY;
      glow(context, x, y, 14, 14, 0, line, dark ? 0.24 : 0.18);
      context.beginPath();
      context.arc(x, y, 1.8, 0, Math.PI * 2);
      context.fillStyle = rgba(line, dark ? 0.72 : 0.6);
      context.fill();
    }
    context.restore();
  }
});
