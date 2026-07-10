import { adminApiBasePath, type Brightness, type Device } from "@imageshow/shared";
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
  extra?: Record<string, unknown> | null;
  status: string;
  deleted_at?: string | Date | null;
  image_time?: string | Date | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
};

export type PublicImage = Awaited<ReturnType<typeof publicImage>>;
export type PublicImageDetail = Awaited<ReturnType<typeof publicImageDetail>>;

export type PublicImageCardRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "width" | "height" | "ext" | "object_key" | "storage_slug" | "is_link" | "title" | "image_time" | "status"
>;

export type PublicImageDetailRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "ext" | "object_key" | "storage_slug" | "is_link" | "author" | "description" | "source" | "original" | "status"
>;

type PublicImageUrlRecord = Pick<
  ImageRecord,
  "id" | "device" | "brightness" | "theme" | "ext" | "object_key" | "storage_slug" | "is_link"
>;

export type ImportSessionRecord = {
  id: string;
  mode: "upload" | "download" | "proxy";
  status: string;
  expires_at: string | Date;
};

export function importSessionResponse(row: ImportSessionRecord) {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    upload_url: row.mode === "upload" ? `${adminApiBasePath}/imports/${row.id}/file` : undefined,
    prepare_url: `${adminApiBasePath}/imports/${row.id}/prepare`,
    preview_url: `${adminApiBasePath}/imports/${row.id}/preview`,
    preview_full_url: `${adminApiBasePath}/imports/${row.id}/preview/full`,
    expires_at: new Date(row.expires_at).toISOString()
  };
}

async function publicUrlsForRow(row: PublicImageUrlRecord) {
  const storageSlug = row.storage_slug;
  const isLink = Boolean(row.is_link);
  const linkParams = isLink ? { id: row.id, device: row.device, brightness: row.brightness, theme: row.theme, ext: row.ext } : undefined;
  const urls = await publicImageUrls(row.object_key, storageSlug, isLink, linkParams);
  return { storageSlug, isLink, urls };
}

export async function publicImage(row: ImageRecord, tags?: string[]) {
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
    extra: row.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? row.extra : {},
    has_distinct_original: hasDistinctOriginal,
    status: row.status,
    tags: tagList,
    deleted_at: row.deleted_at ?? null,
    image_time: row.image_time ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    ...urls
  };
}

export async function publicImages(rows: ImageRecord[]) {
  const tagMap = await getTagsForImages(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => publicImage(row, tagMap.get(row.id) ?? [])));
}

export async function publicImageDetail(row: PublicImageDetailRecord) {
  const { isLink, urls } = await publicUrlsForRow(row);
  const original = row.original ?? "";
  const hasDistinctOriginal = hasDistinctOriginalUrl(original, isLink ? row.object_key : urls.object_url);

  return {
    id: row.id,
    author: row.author ?? "",
    description: row.description ?? "",
    source: row.source ?? "",
    has_distinct_original: hasDistinctOriginal,
    object_url: urls.object_url
  };
}

export type PublicImageCard = Awaited<ReturnType<typeof publicImageCard>>;

async function publicImageCard(row: PublicImageCardRecord, tags: string[] = []) {
  const { urls } = await publicUrlsForRow(row);
  return {
    id: row.id,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    title: row.title ?? "",
    tags,
    image_time: row.image_time ?? null,
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
