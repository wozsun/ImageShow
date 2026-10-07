import type { ImageUpdateItemInputDto, EditableImageSnapshotDto, AdminImageListItemDto } from "@imageshow/shared/browser";

export type ImageEditorSource = Pick<AdminImageListItemDto, "id"> &
  Partial<EditableImageSnapshotDto> &
  Partial<Pick<AdminImageListItemDto, "deleted_at" | "status">>;

/** 编辑弹窗的用途：编辑属性，或只核对图片后移入回收站。 */
export type ImageEditorIntent = "edit" | "delete";

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
