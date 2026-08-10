import type { Brightness, Device } from "./common.ts";

export type FacetOptionDto = {
  slug: string;
  display_name: string;
};

export type GalleryFacetsDto = {
  devices: string[];
  brightnesses: string[];
  themes: FacetOptionDto[];
  tags: FacetOptionDto[];
  authors: Array<FacetOptionDto & { link: string }>;
};

export type GalleryStatsFacetDto = FacetOptionDto & {
  image_count: number;
};

export type GalleryStatsDto = {
  total_images: number;
  matching_images: number;
  devices: Array<{ device: Device; image_count: number }>;
  brightnesses: Array<{ brightness: Brightness; image_count: number }>;
  categories: Array<{
    device: Device;
    brightness: Brightness;
    image_count: number;
  }>;
  themes: GalleryStatsFacetDto[];
  tags: GalleryStatsFacetDto[];
  authors: Array<GalleryStatsFacetDto & { link: string }>;
};

export type GalleryImageCardDto = {
  id: string;
  title: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  author: string;
  thumb_url: string;
  width: number;
  height: number;
  tags: string[];
  diff_original: boolean;
  image_time: string | null;
};

export type PublicImageDetailDto = {
  id: string;
  description: string;
  object_url: string;
  source: string;
};

export type PublicImageItemDto = GalleryImageCardDto & PublicImageDetailDto;

export type PublicImageListResponseDto = {
  items: GalleryImageCardDto[];
  next_cursor: string | null;
};

export type PublicImageDetailResponseDto = {
  item: PublicImageDetailDto;
};

export type RandomImageJsonItemDto = {
  id: string;
  object_url: string;
  thumb_url: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  tags: string[];
  width: number;
  height: number;
  image_time: string;
};

export type RandomImageJsonResponseDto = {
  count: number;
  items: RandomImageJsonItemDto[];
};

export type AdminImageItemDto = PublicImageItemDto & {
  status: "ready" | "deleted";
  object_key: string;
  storage_slug: string;
  md5: string;
  original: string;
  image_size?: number;
  deleted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * Fields consumed by the shared admin detail dialog.
 *
 * This deliberately excludes list/edit-only fields such as object_key,
 * original, image_size and status so compact callers do not over-fetch.
 */
export type AdminImageDetailItemDto = PublicImageItemDto & Pick<
  AdminImageItemDto,
  "storage_slug" | "md5" | "created_at" | "updated_at" | "deleted_at"
>;

/** Exact recovery payload consumed by the batch metadata editor. */
export type BatchEditableImageSnapshotDto = Pick<
  AdminImageItemDto,
  | "id"
  | "title"
  | "description"
  | "source"
  | "original"
  | "device"
  | "brightness"
  | "theme"
  | "author"
  | "tags"
  | "thumb_url"
  | "object_url"
  | "width"
  | "height"
  | "image_size"
  | "object_key"
  | "storage_slug"
>;

export type AdminImageListResponseDto = {
  items: AdminImageItemDto[];
  total: number;
  next_cursor: string | null;
};

export type ImageAdminInfoDto = {
  id: string;
  md5: string;
  storage_label: string;
  created_at: string;
  updated_at: string;
};

export type BatchImageUpdateItemResultDto =
  | { id: string; status: "updated" }
  | { id: string; status: "failed"; code: string; message: string };

export type BatchImageUpdateResponseDto = {
  updated: number;
  failed: number;
  results: BatchImageUpdateItemResultDto[];
};

export type BatchImageSnapshotResponseDto = {
  items: BatchEditableImageSnapshotDto[];
};

export type ImageDraftDto = {
  device: Device | "auto";
  brightness: Brightness | "auto";
  theme: string;
  author: string;
  title: string;
  description: string;
  source: string;
  original: string;
  tags: string[];
};

export type BatchImageUpdateItemInputDto = {
  id: string;
} & Partial<ImageDraftDto>;

export type BatchImageUpdateRequestDto = {
  items: BatchImageUpdateItemInputDto[];
};

export type AdminEntityDto = FacetOptionDto & {
  image_count: number;
  link?: string;
};

export type TagDto = Omit<AdminEntityDto, "link">;

export type ThemeDto = Omit<AdminEntityDto, "link">;

export type AuthorDto = AdminEntityDto & { link: string };

export type AdminEntityListResponseDto = {
  items: AdminEntityDto[];
};

export type BatchImageDeleteResponseDto = {
  deleted: number;
  ignored: number;
};

export type BatchImageRestoreResponseDto = {
  restored: number;
  ignored: number;
};

export type TrashPurgeResponseDto = {
  deleted: number;
  failed: number;
  remaining: number;
};

export type SelectedTrashPurgeResponseDto = TrashPurgeResponseDto & {
  ignored: number;
};
