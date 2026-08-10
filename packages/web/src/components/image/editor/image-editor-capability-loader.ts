import { createPageLifetimeModuleLoader } from "../../../lib/page-lifetime-module-loader.js";
import type { ImageEditorTarget } from "./image-editor-types.js";

export type {
  ImageEditorTarget
} from "./image-editor-types.js";

export type ImageEditorCapabilityModule =
  typeof import("./image-editor-capability.js");

export const loadImageEditorCapabilityModule =
  createPageLifetimeModuleLoader<ImageEditorCapabilityModule>(
    () => import("./image-editor-capability.js")
  );

export function imageEditorTargetKey(target: ImageEditorTarget) {
  return target.sources.map((item) => item.id).join(",");
}

export function isImageNotEditableError(error: unknown) {
  return error instanceof Error && error.name === "ImageNotEditableError";
}
