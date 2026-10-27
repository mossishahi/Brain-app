import { canvasRenderer } from "./canvas-renderer";
import { drawLightField } from "./light-field";

export const mountAurora = canvasRenderer((frame) => drawLightField(frame));
