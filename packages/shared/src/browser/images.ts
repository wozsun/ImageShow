import { imageVariants, type ImageVariantByteSizesDto } from "./image-variants.ts";
import { slugMaxLength, slugPattern } from "./vocabulary.ts";
import { type Brightness, type Device } from "./image-classification.ts";

/** Image time is the UUIDv7 timestamp of the image ID (hyphenated lowercase form): its first 12 hex digits are Unix milliseconds, so ordering by ID orders by image time. */
export function imageTimeMs(id: string) {
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export function imageDevice(width: number, height: number): Device {
  return width >= height ? "pc" : "mb";
}

/** Selector for images without a theme, author or tag, and the theme / author facet slug; never stored. */
export const unsetSelector = "null";

/** A storable theme, author or tag slug: the slug format minus the reserved unset selector. */
export function isNamedSlug(value: string) {
  return value !== unsetSelector && value.length <= slugMaxLength && slugPattern.test(value);
}

export const publicImageOrders = ["random", "latest", "oldest"] as const;
export type PublicImageOrder = (typeof publicImageOrders)[number];
export const publicImageViews = ["show", "gallery"] as const;
export type PublicImageView = (typeof publicImageViews)[number];
export const publicImageBrowseLimit = 800;

export const adminImageListReadStartedAtHeader = "X-ImageShow-Read-Started-At";

export type FacetOptionDto = {
  slug: string;
  display_name: string;
};

export type GalleryFacetsDto = {
  themes: FacetOptionDto[];
  tags: FacetOptionDto[];
  authors: Array<FacetOptionDto & { link: string }>;
};

export type GalleryStatsFacetDto = {
  slug: string;
  image_count: number;
};

export type GalleryStatsDto = {
  total_images: number;
  matching_images: number;
  tag_groups?: Array<{ tag: string; image_count: number }>;
  devices: Array<{ device: Device; image_count: number }>;
  brightnesses: Array<{ brightness: Brightness; image_count: number }>;
  themes: GalleryStatsFacetDto[];
  tags: GalleryStatsFacetDto[];
  authors: GalleryStatsFacetDto[];
};

export type ShowImageCardDto = {
  id: string;
  title: string;
  base_url: string;
  width: number;
  height: number;
};

export type ImageCardBaseDto = ShowImageCardDto & {
  device: Device;
  brightness: Brightness;
  theme: string | null;
  author: string | null;
  tags: string[];
};

/**
 * Stable image attributes used by the Gallery. Display names belong to the
 * session-scoped Gallery facets response rather than every cursor page.
 */
export type GalleryImageCardDto = ShowImageCardDto & Pick<ImageCardBaseDto, "theme" | "tags">;

type ImageDetailFieldsDto = Pick<
  ImageCardBaseDto,
  "device" | "brightness" | "author" | "theme" | "tags"
> & {
  description: string;
  base_url: string;
  source: string | null;
};

/**
 * 标题及画廊主题、标签复用列表当前值，详情请求不负责刷新这些字段。
 * 允许访问原图的请求投影布尔 original，其余响应不含该字段。
 */
export type PublicImageDetailDto<View extends PublicImageView = "show"> =
  Omit<ImageDetailFieldsDto, "theme" | "tags"> & { original?: boolean }
  & (View extends "show" ? Pick<ImageCardBaseDto, "theme" | "tags"> : {});

type ImageDetailItemDto = ImageDetailFieldsDto & { id: string; title: string };

/**
 * Original access belongs to the site origin, not the storage image root.
 * Editable data carries the raw original and details carry a boolean; both are truthy only when an original exists.
 */
export function imageOriginalUrl(image: { id: string; original?: string | boolean }) {
  return image.original ? `/images/original/${encodeURIComponent(image.id)}` : null;
}

export type PublicImageListResponseDto<View extends PublicImageView = "gallery"> = {
  items: Array<View extends "show" ? ShowImageCardDto : GalleryImageCardDto>;
  next_cursor: string | null;
};

export type PublicImageDetailResponseDto<View extends PublicImageView = "show"> = {
  item: PublicImageDetailDto<View>;
};

export const randomImageSizes = imageVariants;
export type RandomImageSize = (typeof randomImageSizes)[number];

export const randomFallbackDimensions = ["device", "brightness", "author", "tag", "theme"] as const;
export type RandomFallbackDimension = (typeof randomFallbackDimensions)[number];

export type RandomImageJsonItemDto = {
  id: string;
  title: string;
  author: string | null;
  device: Device;
  brightness: Brightness;
  theme: string | null;
  tags: string[];
  width: number;
  height: number;
  url: string;
  byte_size: number;
};

export type RandomImageJsonResponseDto = {
  count: number;
  fallback: RandomFallbackDimension[];
  items: RandomImageJsonItemDto[];
};

type ImageAdminStorageDto = {
  variants: ImageVariantByteSizesDto;
  storage_label: string;
};

export type ImageAdminInfoDto = ImageAdminStorageDto & {
  created_at: string;
  updated_at: string;
};

/** Exact recovery payload consumed by the image metadata editor. */
export type EditableImageSnapshotDto = ImageDetailItemDto &
  Pick<ShowImageCardDto, "width" | "height"> & ImageAdminStorageDto & {
    original: string;
  };

/** Admin detail input; it only reads whether `original` is truthy. */
export type AdminImageDetailItemDto = ImageDetailItemDto & ImageAdminInfoDto & {
  original: string | boolean;
};

/** Compact overview projection: the detail needs only the original flag, not the raw address. */
export type AdminImageRecentItemDto = AdminImageDetailItemDto & { original: boolean };

/** A list item is also a complete editable snapshot and admin detail. */
export type AdminImageListItemDto = EditableImageSnapshotDto & AdminImageDetailItemDto & {
  status: "ready" | "deleted";
  purge_pending: boolean;
  in_group?: boolean;
  deleted_at: string | null;
};

export type AdminImageListResponseDto = {
  items: AdminImageListItemDto[];
  total: number;
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
  items: (EditableImageSnapshotDto & { in_group?: boolean })[];
};

export type ImageDraftDto = {
  device: Device | "auto";
  brightness: Brightness | "auto";
  theme: string | null;
  author: string | null;
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

export type AdminEntityListResponseDto<Item extends AdminEntityDto = AdminEntityDto> = {
  items: Item[];
};

type ImageTrashItemResultDto = {
  id: string;
  status: "trashed" | "ignored";
};

export type ImageTrashResponseDto = {
  requested: number;
  trashed: number;
  ignored: number;
  results: ImageTrashItemResultDto[];
};

type ImageRestoreItemResultDto = {
  id: string;
  status: "restored" | "ignored";
};

export type ImageRestoreResponseDto = {
  requested: number;
  restored: number;
  ignored: number;
  results: ImageRestoreItemResultDto[];
};

export type ImagePurgeRequestDto = { scope: "selected"; ids: string[] } | { scope: "all" };

/** Receipt for the committed deletion intent; progress arrives on the event stream. */
export type ImagePurgeResponseDto = {
  requested: number;
  queued: number;
  already_queued: number;
  ignored: number;
};

export const trashPurgeEventsPath = "/api/admin/images/purge/events";

/**
 * Every permanent deletion that still has its image: `pending` is waiting or
 * running, `failed` waits for a retry or for maintenance. The stream ends after
 * the first state without pending work.
 */
export type TrashPurgeProgressDto = {
  pending: number;
  failed: number;
};

export const imageTitleMaxLength = 80;

export const imageDescriptionMaxLength = 500;
