import { imageVariants, type ImageVariantsDto, type ImageVariantByteSizesDto } from "./image-variants.ts";
import { slugMaxLength, slugPattern, type Brightness, type Device } from "./common.ts";

/** Stable physical identity, independent of editable image classification. */
export function storageObjectKey(id: string) {
  return `${id.slice(-2)}/${id}.webp`;
}

export function imageDevice(width: number, height: number): Device {
  return width >= height ? "pc" : "mb";
}

/** Theme and author selector for images without one, and its virtual facet slug; never stored. */
export const unsetSelector = "null";

/** A storable theme or author slug: the slug format minus the reserved unset selector. */
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
  image_time: string;
};

/**
 * Stable image attributes used by the Gallery. Display names belong to the
 * session-scoped Gallery facets response rather than every cursor page.
 */
export type GalleryImageCardDto = ShowImageCardDto & Pick<ImageCardBaseDto, "theme" | "tags">;

/** 标题及画廊主题、标签复用列表当前值，详情请求不负责刷新这些字段。 */
export type PublicImageDetailDto<View extends PublicImageView = "show"> = Pick<
  ImageCardBaseDto,
  "device" | "brightness" | "author" | "image_time"
> & {
  description: string;
  base_url: string;
  original_url: string | null;
  source: string | null;
} & (View extends "show" ? Pick<ImageCardBaseDto, "theme" | "tags"> : {});

export type ImageDetailItemDto = PublicImageDetailDto & { id: string; title: string };

export type PublicImageListResponseDto<View extends PublicImageView = "gallery"> = {
  items: Array<View extends "show" ? ShowImageCardDto : GalleryImageCardDto>;
  next_cursor: string | null;
};

export type PublicImageDetailResponseDto<View extends PublicImageView = "show"> = {
  item: PublicImageDetailDto<View>;
};

export const randomImageSizes = imageVariants;
export type RandomImageSize = (typeof randomImageSizes)[number];

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
  image_time: string;
  url: string;
  byte_size: number;
};

export type RandomImageJsonResponseDto = {
  count: number;
  items: RandomImageJsonItemDto[];
};

export type AdminImageListItemDto = ImageDetailItemDto & ShowImageCardDto & {
  variants: ImageVariantsDto;
  status: "ready" | "deleted";
  purge_pending: boolean;
  storage_slug: string;
  original: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Fields consumed by the shared admin detail dialog.
 *
 * List/edit-only fields remain outside this compact response.
 */
export type AdminImageDetailItemDto = ImageDetailItemDto & ImageAdminInfoDto;

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
  author: string | null;
  tags: string[];
  base_url: string;
  variants: ImageVariantsDto;
  original_url: string | null;
  width: number;
  height: number;
  storage_slug: string;
};

export type AdminImageListResponseDto = {
  items: AdminImageListItemDto[];
  total: number;
};

export type ImageAdminInfoDto = {
  variants: ImageVariantByteSizesDto;
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

export type ImagePurgeRequestDto = { scope: "selected"; ids: string[] } | { scope: "all" };

export type ImagePurgeResponseDto = {
  requested: number;
  queued: number;
  already_queued: number;
  deleted: number;
  remaining: number;
  ignored: number;
};
