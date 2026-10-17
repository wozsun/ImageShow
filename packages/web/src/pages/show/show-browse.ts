import type { ShowMode } from "@imageshow/shared/browser";
import { imageBatchTier } from "../../lib/gallery/image-browse.js";
import { showFloatPacking, showFloatStepSide } from "./pixi/show-pixi-layout.js";

export function showInitialBatchLimit(options: {
  width: number;
  height: number;
  mode: ShowMode;
  columns: number;
  floatSizeIndex: number;
  device: string;
}) {
  const { width, height, columns, mode, device } = options;
  if (mode === "float") {
    // The float stream spans the viewport plus half a screen at each end.
    const side = showFloatStepSide(options.floatSizeIndex, width, height);
    const resident = Math.min(
      180,
      Math.ceil((width * height * 2 * showFloatPacking) / Math.max(1, side * side))
    );
    return imageBatchTier(resident + 100, [200, 500, 800]);
  }
  const ratio = device === "mb" ? 16 / 9 : 9 / 16;
  const imageWidth = width / Math.max(0.5, columns);
  const resident =
    Math.ceil(columns * 2.2 + 2) *
    Math.ceil((height * 2.2) / Math.max(1, imageWidth * ratio) + 2);
  return imageBatchTier(resident + 100, [200, 500, 800]);
}
