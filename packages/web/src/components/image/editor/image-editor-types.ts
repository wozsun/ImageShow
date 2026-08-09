import type {
  BatchEditableImageSnapshot,
  ImageItem
} from "../../../lib/types.js";

export type ImageEditorSource = Pick<ImageItem, "id"> &
  Partial<BatchEditableImageSnapshot> &
  Partial<Pick<ImageItem, "deleted_at" | "status">>;

export type ImageEditorTarget = {
  kind: "single" | "batch";
  sources: ImageEditorSource[];
};
