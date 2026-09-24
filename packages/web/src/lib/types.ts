export type { AdminSettings, Brightness, Device } from "@imageshow/shared/browser";
import type {
  AdminUserDto,
  AdvancedConfigPreviewDto,
  AdminImageDetailItemDto,
  AdminImageListItemDto,
  AuthorDto,
  EditableImageSnapshotDto,
  FacetOptionDto,
  GalleryImageCardDto,
  ImageDetailItemDto,
  ImageDraftDto,
  ImageAdminInfoDto,
  PublicImageDetailDto,
  RandomMethod,
  RuntimeConfigChangeSummaryDto,
  StorageBackendAdminDto,
  StorageBackendS3Dto,
  TagDto,
  ThemeDto
} from "@imageshow/shared/browser";

export type GalleryImageCard = GalleryImageCardDto;
export type ImageDetailItem = ImageDetailItemDto;
export type PublicImageItem = GalleryImageCard & PublicImageDetailDto;
export type AdminImageDetailItem = AdminImageDetailItemDto;
export type EditableImageSnapshot = EditableImageSnapshotDto;
export type AdminImageListItem = AdminImageListItemDto;
export type ImageAdminInfo = ImageAdminInfoDto;

export type Tag = TagDto;
export type Theme = ThemeDto;
export type Author = AuthorDto;
export type ImageDraft = ImageDraftDto;

// 写入表单中的秘密只存在于 Web 页面和提交请求；共享 DTO 只描述服务端已脱敏的读取结果。
export type S3Settings = Omit<StorageBackendS3Dto, "secret_access_key_configured"> & {
  secret_access_key?: string;
};
export type StorageBackendAdmin = StorageBackendAdminDto;
export type AdvancedConfigPreview = AdvancedConfigPreviewDto;
export type RuntimeConfigChangeSummary = RuntimeConfigChangeSummaryDto;
export type AdminUser = AdminUserDto;

export type FacetOption = FacetOptionDto;

export type RandomMode = "" | RandomMethod;
