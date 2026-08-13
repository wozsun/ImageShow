import type {
  ImageUpdateItemInputDto
} from "@imageshow/shared/browser";
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

export type ImageMetadataSaveCommit = {
  authoritativeItems: EditableImageSnapshot[] | null;
  updates: ImageUpdateItemInputDto[];
};

export type ImageEditorSavedHandler = (
  commit?: ImageMetadataSaveCommit
) => void | Promise<void>;
