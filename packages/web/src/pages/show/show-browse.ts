import type { ShowMode } from "@imageshow/shared/browser";
import { imageBatchTier } from "../../lib/gallery/image-browse.js";
import { showFloatDefaultWidth, showFloatSizeSteps } from "./pixi/show-pixi-layout.js";

export function showInitialBatchLimit(options: {
  width: number;
  height: number;
  mode: ShowMode;
  columns: number;
  floatSizeIndex: number;
  device: string;
}) {
  const { width, height, columns, mode, device } = options;
  const ratio = device === "mb" ? 16 / 9 : 9 / 16;
  const imageWidth = mode === "float"
    ? showFloatDefaultWidth(width) * showFloatSizeSteps[options.floatSizeIndex]!
    : width / Math.max(0.5, columns);
  const resident = mode === "float"
    ? Math.min(180, Math.ceil(width * height * 2.1 / Math.max(1, imageWidth * imageWidth * ratio)))
    : Math.ceil(columns * 2.2 + 2) * Math.ceil(height * 2.2 / Math.max(1, imageWidth * ratio) + 2);
  return imageBatchTier(resident + 100, [200, 500, 800]);
}
