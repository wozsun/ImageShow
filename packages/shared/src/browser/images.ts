import { slugMaxLength, slugPattern, type Brightness, type Device } from "./common.ts";

/** Stable physical identity, independent of editable image classification. */
export function storageObjectKey(id: string, ext: string) {
  return `${id.slice(-2)}/${id}.${ext}`;
}

export function imageDevice(width: number, height: number): Device {
  return width >= height ? "pc" : "mb";
}

/** Query-only selector and virtual facet identity; never a stored theme slug. */
export const unsetThemeFilter = "null";

export function isThemeSlug(value: string) {
  return value !== unsetThemeFilter && value.length <= slugMaxLength && slugPattern.test(value);
}

export const publicImageOrders = ["random", "latest", "oldest"] as const;
export type PublicImageOrder = (typeof publicImageOrders)[number];
export const publicImageViews = ["show", "gallery"] as const;
export type PublicImageView = (typeof publicImageViews)[number];
export const publicImageBrowseLimit = 800;

export const adminImageListReadStartedAtHeader =
  "X-ImageShow-Read-Started-At";

export type FacetOptionDto = {
  slug: string;
  display_name: string;
};

export type GalleryFacetsDto = {
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
  tag_groups?: Array<{ tag: string; image_count: number }>;
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

export type ShowImageCardDto = {
  id: string;
  title: string;
  thumb_url: string;
  width: number;
  height: number;
};

export type ImageCardBaseDto = ShowImageCardDto & {
  device: Device;
  brightness: Brightness;
  theme: string | null;
  author: string;
  tags: string[];
  image_time: string;
};

/**
 * Stable image attributes used by the Gallery. Display names belong to the
 * session-scoped Gallery facets response rather than every cursor page.
 */
export type GalleryImageCardDto = ImageCardBaseDto;

export type PublicImageDetailDto = Pick<
  ImageCardBaseDto,
  "device" | "brightness" | "theme" | "author" | "tags" | "image_time"
> & {
  id: string;
  description: string;
  object_url: string;
  original_url: string | null;
  source: string | null;
};

export type ImageDetailItemDto = ImageCardBaseDto & PublicImageDetailDto;

export type PublicImageListResponseDto<View extends PublicImageView = "gallery"> = {
  items: Array<View extends "show" ? ShowImageCardDto : GalleryImageCardDto>;
  next_cursor: string | null;
};

export type PublicImageDetailResponseDto = {
  item: PublicImageDetailDto;
};

export const randomImageSizes = ["thumb", "full"] as const;
export type RandomImageSize = (typeof randomImageSizes)[number];

export type RandomImageJsonItemDto = {
  id: string;
  title: string;
  author: string;
  device: Device;
  brightness: Brightness;
  theme: string | null;
  tags: string[];
  width: number;
  height: number;
  image_time: string;
} & (
  | { object_url: string; thumb_url?: string }
  | { object_url?: never; thumb_url: string }
);

export type RandomImageJsonResponseDto = {
  count: number;
  items: RandomImageJsonItemDto[];
};

export type AdminImageListItemDto = ImageDetailItemDto & {
  status: "ready" | "deleted";
  purge_pending: boolean;
  ext: string;
  storage_slug: string;
  md5: string;
  original: string;
  image_size: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Fields consumed by the shared admin detail dialog.
 *
 * This deliberately excludes list/edit-only fields such as ext,
 * original, image_size and status so compact callers do not over-fetch.
 */
export type AdminImageDetailItemDto = ImageDetailItemDto & {
  storage_label: string;
  md5: string;
  created_at: string;
  updated_at: string;
};

/** Exact recovery payload consumed by the image metadata editor. */
export type EditableImageSnapshotDto = {
  id: string;
  title: string;
  description: string;
  source: string | null;
  original: string;
  device: Device;
  brightness: Brightness;
  theme: string | null;
  author: string;
  tags: string[];
  thumb_url: string;
  object_url: string;
  original_url: string | null;
  width: number;
  height: number;
  image_size: number;
  ext: string;
  storage_slug: string;
};

export type AdminImageListResponseDto = {
  items: AdminImageListItemDto[];
  total: number;
};

export type ImageAdminInfoDto = {
  id: string;
  md5: string;
  storage_label: string;
  created_at: string;
  updated_at: string;
};

export type ImageUpdateItemResultDto =
  | { id: string; status: "updated" }
  | { id: string; status: "failed"; code: string; message: string };

export type ImageUpdateResponseDto = {
  updated: number;
  failed: number;
  results: ImageUpdateItemResultDto[];
};

export type ImageSnapshotResponseDto = {
  items: EditableImageSnapshotDto[];
};

export type ImageDraftDto = {
  device: Device | "auto";
  brightness: Brightness | "auto";
  theme: string | null;
  author: string;
  title: string;
  description: string;
  source: string;
  original: string;
  tags: string[];
};

export type ImageUpdateItemInputDto = {
  id: string;
} & Partial<ImageDraftDto>;

export type ImageUpdateRequestDto = {
  items: ImageUpdateItemInputDto[];
};

export type AdminEntityDto = FacetOptionDto & {
  sort_order: number;
  image_count: number;
  link?: string;
};

export type TagDto = Omit<AdminEntityDto, "link">;

export type ThemeDto = Omit<AdminEntityDto, "link">;

export type AuthorDerivedIdentityDto = {
  provider: "weibo";
  id: string;
};

export type AuthorDto = AdminEntityDto & {
  link: string;
  derived_identity: AuthorDerivedIdentityDto | null;
};

export type AuthorMutationResponseDto = {
  ok: true;
  item: AuthorDto;
};

export type AdminEntityListResponseDto<
  Item extends AdminEntityDto = AdminEntityDto
> = {
  items: Item[];
};

export type ImageTrashItemResultDto = {
  id: string;
  status: "trashed" | "ignored";
};

export type ImageTrashResponseDto = {
  requested: number;
  trashed: number;
  ignored: number;
  results: ImageTrashItemResultDto[];
};

export type ImageRestoreItemResultDto = {
  id: string;
  status: "restored" | "ignored";
};

export type ImageRestoreResponseDto = {
  requested: number;
  restored: number;
  ignored: number;
  results: ImageRestoreItemResultDto[];
};

export type ImagePurgeRequestDto =
  | { scope: "selected"; ids: string[] }
  | { scope: "all" };

export type ImagePurgeResponseDto = {
  requested: number;
  queued: number;
  already_queued: number;
  deleted: number;
  remaining: number;
  ignored: number;
};
