import type {
  EditableImageSnapshot,
  AdminImageListItem
} from "../../../lib/types.js";

export type ImageEditorSource = Pick<AdminImageListItem, "id"> &
  Partial<EditableImageSnapshot> &
  Partial<Pick<AdminImageListItem, "deleted_at" | "status">>;

export type ImageEditorTarget = {
  sources: ImageEditorSource[];
};
