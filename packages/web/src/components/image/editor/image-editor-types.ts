import type {
  EditableImageSnapshot,
  ImageItem
} from "../../../lib/types.js";

export type ImageEditorSource = Pick<ImageItem, "id"> &
  Partial<EditableImageSnapshot> &
  Partial<Pick<ImageItem, "deleted_at" | "status">>;

export type ImageEditorTarget = {
  sources: ImageEditorSource[];
};
