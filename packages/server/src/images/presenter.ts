import {
  adminApiBasePath,
  type AdminImageItemDto,
  type Brightness,
  type Device,
  type GalleryImageCardDto,
  type PublicImageDetailDto
} from "@imageshow/shared";
import { publicImageUrls } from "../storage/storage.ts";
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
  is_link: boolean;

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
  "is_link",
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

export type PublicImage = AdminImageItemDto & { ext: string };
export type PublicImageDetail = PublicImageDetailDto;

export type PublicImageCardRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "width" | "height" | "ext" | "object_key" | "storage_slug" | "is_link" | "author" | "title" | "original" | "image_time" | "status"
>;

export type PublicImageDetailRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "ext" | "object_key" | "storage_slug" | "is_link" | "status"
> & {
  description: string | null;
  source: string | null;
  original: string | null;
};

type PublicImageUrlRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "ext" | "object_key" | "storage_slug" | "is_link"
>;

export type OverviewRecentImageRecord = PublicImageUrlRecord & Pick<ImageRecord, "title">;

export type ImportSessionRecord = {
  id: string;
  mode: "upload" | "download" | "proxy";
};

export function importSessionResponse(row: ImportSessionRecord) {
  return {
    id: row.id,
    upload_url: row.mode === "upload" ? `${adminApiBasePath}/imports/${row.id}/file` : undefined,
    prepare_url: `${adminApiBasePath}/imports/${row.id}/prepare`
  };
}

async function publicUrlsForRow(row: PublicImageUrlRecord) {
  const storageSlug = row.storage_slug;
  const isLink = Boolean(row.is_link);
  const linkParams = isLink ? { id: row.id, device: row.device, brightness: row.brightness, theme: row.theme, ext: row.ext } : undefined;
  const urls = await publicImageUrls(row.object_key, storageSlug, isLink, linkParams);
  return { storageSlug, isLink, urls };
}

function serializeTimestamp(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

export async function importCommitImage(row: PublicImageUrlRecord) {
  const { urls } = await publicUrlsForRow(row);
  return {
    object_url: urls.object_url,
    thumb_url: urls.thumb_url
  };
}

export async function overviewRecentImage(row: OverviewRecentImageRecord) {
  const { urls } = await publicUrlsForRow(row);
  return {
    id: row.id,
    title: row.title ?? "",
    thumb_url: urls.thumb_url
  };
}

async function publicImage(
  row: ImageRecord,
  tags?: string[]
): Promise<PublicImage> {
  const { storageSlug, isLink, urls } = await publicUrlsForRow(row);
  const original = row.original ?? "";
  const hasDistinctOriginal = hasDistinctOriginalUrl(original, isLink ? row.object_key : urls.object_url);

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
    is_link: isLink,
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

export async function publicImages(rows: ImageRecord[]) {
  const tagMap = await getTagsForImages(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => publicImage(row, tagMap.get(row.id) ?? [])));
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

export type PublicImageCard = GalleryImageCardDto;

async function publicImageCard(
  row: PublicImageCardRecord,
  tags: string[] = []
): Promise<GalleryImageCardDto> {
  const { isLink, urls } = await publicUrlsForRow(row);
  const original = row.original ?? "";
  const hasDistinctOriginal = hasDistinctOriginalUrl(original, isLink ? row.object_key : urls.object_url);
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

export type AdminImage = Omit<PublicImage, "ext">;

export function adminImageView(image: PublicImage): AdminImage {
  const { ext: _ext, ...rest } = image;
  if (image.status !== "deleted") return rest;
  return {
    ...rest,
    object_url: `${adminApiBasePath}/images/${image.id}/raw`,
    thumb_url: `${adminApiBasePath}/images/${image.id}/thumb`
  };
}
