import type { ImageUpdateItemInputDto, EditableImageSnapshotDto, AdminImageListItemDto } from "@imageshow/shared/browser";

export type ImageEditorSource = Pick<AdminImageListItemDto, "id"> &
  Partial<EditableImageSnapshotDto> &
  Partial<Pick<AdminImageListItemDto, "deleted_at" | "status">>;

/** 编辑弹窗的用途：编辑属性，或只读核对后删除图片、修改分组成员。 */
export type ImageEditorIntent = "edit" | "delete" | "group-add" | "group-remove";

export type ImageEditorTarget = {
  sources: ImageEditorSource[];
  intent?: ImageEditorIntent;
  /** 由另一个弹窗直接交接打开：遮罩已在屏幕上，不再淡入。 */
  fromDialog?: boolean;
};

export type ImageMetadataSaveCommit = {
  authoritativeItems: EditableImageSnapshotDto[] | null;
  updates: ImageUpdateItemInputDto[];
};

export type ImageEditorSavedHandler = (commit?: ImageMetadataSaveCommit) => void | Promise<void>;
