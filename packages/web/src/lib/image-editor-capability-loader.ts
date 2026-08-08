import type {
  BatchEditableImageSnapshot,
  ImageItem
} from "./types.js";
import { createPageLifetimeModuleLoader } from "./page-lifetime-module-loader.js";

export type ImageEditorSource = Pick<ImageItem, "id"> &
  Partial<BatchEditableImageSnapshot> &
  Partial<Pick<ImageItem, "deleted_at" | "status">>;

export type ImageEditorTarget = {
  kind: "single" | "batch";
  sources: ImageEditorSource[];
};

export type ImageEditorCapabilityModule =
  typeof import("../pages/admin/image-editor-capability.js");

export const loadImageEditorCapabilityModule =
  createPageLifetimeModuleLoader<ImageEditorCapabilityModule>(
    () => import("../pages/admin/image-editor-capability.js")
  );

export function imageEditorTargetKey(target: ImageEditorTarget) {
  return `${target.kind}:${target.sources.map((item) => item.id).join(",")}`;
}

export function isImageNotEditableError(error: unknown) {
  return error instanceof Error && error.name === "ImageNotEditableError";
}
