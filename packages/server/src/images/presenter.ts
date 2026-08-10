import {
  adminApiBasePath,
  type AdminImageDetailItemDto,
  type AdminImageItemDto,
  type EditableImageSnapshotDto,
  type Brightness,
  type Device,
  type GalleryImageCardDto,
  type ImportMode,
  type ImportSessionHandleDto,
  type PublicImageDetailDto
} from "@imageshow/shared/browser";
import {
  publicImageUrlsForDelivery,
  type ThumbnailUrlDelivery
} from "../storage/public-urls.ts";
import { getTagsForImages } from "../tags/query.ts";
import { hasDistinctOriginalUrl } from "./original-link.ts";

export type ImageRecord = {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  width?: number | string | null;
  height?: number | string | null;
  image_size?: number | string | null;
  ext: string;
  md5?: string | null;
  object_key: string;
  storage_slug: string;

  author?: string | null;
  title?: string | null;
  description?: string | null;
  source?: string | null;
  original?: string | null;
  status: string;
  deleted_at?: string | Date | null;
  image_time?: string | Date | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
};

/**
 * 构造完整管理端图片 DTO 所需的数据库列。
 *
 * 集中维护可避免列表与判重查询重新退回 `SELECT *`，把仅供数据库内部
 * 预留的字段或其他流程字段带入 Node.js。
 */
export const imagePresentationColumns = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "image_size",
  "ext",
  "md5",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  "status",
  "deleted_at",
  "image_time",
  "created_at",
  "updated_at"
].join(", ");

/**
 * Full image projection with tags read in the same PostgreSQL statement.
 *
 * Small snapshot-style read models use this to avoid a second round trip and
 * to keep metadata and tags on one statement-level MVCC snapshot.
 */
const imageTagsPresentationColumn = `ARRAY(
  SELECT it.tag_slug
    FROM image_tag it
   WHERE it.image_id = metadata.id
   ORDER BY it.tag_slug
) AS tags`;

export const imageDetailPresentationColumnsWithTags = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "ext",
  "md5",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  "status",
  "image_time",
  "created_at",
  "updated_at",
  imageTagsPresentationColumn
].join(", ");

export const editableImagePresentationColumnsWithTags = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "image_size",
  "ext",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  "status",
  imageTagsPresentationColumn
].join(", ");

export type PublicImage = AdminImageItemDto & { ext: string };
export type ImageRecordWithTags = ImageRecord & { tags: string[] };

export type PublicImageCardRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "width" | "height" | "ext" | "object_key" | "storage_slug" | "author" | "title" | "original" | "image_time" | "status"
>;

export type PublicImageDetailRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "ext" | "object_key" | "storage_slug" | "status"
> & {
  description: string | null;
  source: string | null;
  original: string | null;
};

type PublicImageUrlRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "ext" | "object_key" | "storage_slug"
>;

export type ImportSessionRecord = {
  id: string;
  mode: ImportMode;
};

export function importSessionResponse(
  row: ImportSessionRecord
): ImportSessionHandleDto {
  return {
    id: row.id,
    upload_url: row.mode === "upload" ? `${adminApiBasePath}/imports/${row.id}/file` : undefined,
    materialize_url: row.mode === "download"
      ? `${adminApiBasePath}/imports/${row.id}/materialize`
      : undefined,
    prepare_url: `${adminApiBasePath}/imports/${row.id}/prepare`
  };
}

async function publicUrlsForRow(
  row: PublicImageUrlRecord,
  thumbnailDelivery: ThumbnailUrlDelivery = "application"
) {
  const storageSlug = row.storage_slug;
  const urls = await publicImageUrlsForDelivery(
    row.object_key,
    storageSlug,
    thumbnailDelivery
  );
  return { storageSlug, urls };
}

function serializeTimestamp(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

export async function importCommitImage(row: ImageRecord) {
  return adminImageView(await presentedImage(row, undefined, "direct"));
}

async function presentedImage(
  row: ImageRecord,
  tags?: string[],
  thumbnailDelivery: ThumbnailUrlDelivery = "application"
): Promise<PublicImage> {
  const { storageSlug, urls } = await publicUrlsForRow(
    row,
    thumbnailDelivery
  );
  const original = row.original ?? "";
  const hasDistinctOriginal = hasDistinctOriginalUrl(original, urls.object_url);

  const tagList = tags ?? (await getTagsForImages([row.id])).get(row.id) ?? [];
  return {
    id: row.id,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author ?? "",
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    image_size: Number(row.image_size ?? 0),
    ext: row.ext,
    md5: row.md5 ?? "",
    object_key: row.object_key,
    storage_slug: storageSlug,
    title: row.title ?? "",
    description: row.description ?? "",
    source: row.source ?? "",
    original,
    diff_original: hasDistinctOriginal,
    status: row.status === "deleted" ? "deleted" : "ready",
    tags: tagList,
    deleted_at: serializeTimestamp(row.deleted_at),
    image_time: serializeTimestamp(row.image_time),
    created_at: serializeTimestamp(row.created_at),
    updated_at: serializeTimestamp(row.updated_at),
    ...urls
  };
}

export async function adminImages(rows: ImageRecord[]) {
  const tagMap = await getTagsForImages(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => presentedImage(
    row,
    tagMap.get(row.id) ?? [],
    "direct"
  )));
}

export function adminImagesWithTags(rows: ImageRecordWithTags[]) {
  return Promise.all(rows.map((row) => presentedImage(
    row,
    row.tags,
    "direct"
  )));
}

export async function publicImageDetail(
  row: PublicImageDetailRecord
): Promise<PublicImageDetailDto> {
  const { urls } = await publicUrlsForRow(row);

  return {
    id: row.id,
    description: row.description ?? "",
    source: row.source ?? "",
    object_url: urls.object_url
  };
}


async function publicImageCard(
  row: PublicImageCardRecord,
  tags: string[] = []
): Promise<GalleryImageCardDto> {
  const { urls } = await publicUrlsForRow(row);
  const original = row.original ?? "";
  const hasDistinctOriginal = hasDistinctOriginalUrl(original, urls.object_url);
  return {
    id: row.id,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author ?? "",
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    title: row.title ?? "",
    tags,
    diff_original: hasDistinctOriginal,
    image_time: serializeTimestamp(row.image_time),
    thumb_url: urls.thumb_url
  };
}

export async function publicImageCards(rows: PublicImageCardRecord[]) {
  const tagMap = await getTagsForImages(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => publicImageCard(row, tagMap.get(row.id) ?? [])));
}

export function publicImageCardsWithTags(
  rows: Array<PublicImageCardRecord & { tags: string[] }>
) {
  return Promise.all(rows.map((row) => publicImageCard(row, row.tags)));
}

export type AdminImage = Omit<PublicImage, "ext">;

export function adminImageView(image: PublicImage): AdminImage {
  const { ext: _ext, ...rest } = image;
  if (image.status !== "deleted") return rest;
  const { thumb_fallback_url: _thumbFallbackUrl, ...deletedRest } = rest;
  return {
    ...deletedRest,
    object_url: `${adminApiBasePath}/images/${image.id}/raw`,
    thumb_url: `${adminApiBasePath}/images/${image.id}/thumb`
  };
}

export function adminImageDetailView(
  image: PublicImage
): AdminImageDetailItemDto {
  return {
    id: image.id,
    title: image.title,
    device: image.device,
    brightness: image.brightness,
    theme: image.theme,
    author: image.author,
    thumb_url: image.thumb_url,
    thumb_fallback_url: image.thumb_fallback_url,
    width: image.width,
    height: image.height,
    tags: image.tags,
    diff_original: image.diff_original,
    image_time: image.image_time,
    description: image.description,
    object_url: image.object_url,
    source: image.source,
    storage_slug: image.storage_slug,
    md5: image.md5,
    created_at: image.created_at,
    updated_at: image.updated_at
  };
}

export function editableImageSnapshotView(
  image: PublicImage
): EditableImageSnapshotDto {
  return {
    id: image.id,
    title: image.title,
    description: image.description,
    source: image.source,
    original: image.original,
    device: image.device,
    brightness: image.brightness,
    theme: image.theme,
    author: image.author,
    tags: image.tags,
    thumb_url: image.thumb_url,
    thumb_fallback_url: image.thumb_fallback_url,
    object_url: image.object_url,
    width: image.width,
    height: image.height,
    image_size: image.image_size,
    object_key: image.object_key,
    storage_slug: image.storage_slug
  };
}
