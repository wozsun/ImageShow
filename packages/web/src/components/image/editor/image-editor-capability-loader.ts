import { createPageLifetimeModuleLoader } from "../../../lib/page-lifetime-module-loader.js";
import type { ImageEditorTarget } from "./image-editor-types.js";

export type {
  ImageEditorIntent,
  ImageEditorTarget,
  ImageMetadataSaveCommit
} from "./image-editor-types.js";

export type ImageEditorCapabilityModule = typeof import("./image-editor-capability.js");
export type ImageEditorOpenResult = "opened" | "failed" | "interrupted";

export const loadImageEditorCapabilityModule =
  createPageLifetimeModuleLoader<ImageEditorCapabilityModule>(
    () => import("./image-editor-capability.js")
  );

export function imageEditorTargetKey(target: ImageEditorTarget) {
  return target.items
    ? `items:${target.items.map((item) => item.id).join(",")}`
    : `ids:${target.ids.join(",")}`;
}

export function isImageNotEditableError(error: unknown) {
  return error instanceof Error && error.name === "ImageNotEditableError";
}
