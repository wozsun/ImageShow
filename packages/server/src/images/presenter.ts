import { adminApiBasePath, type Brightness, type Device } from "@imageshow/shared";
import { setImageLookups } from "./image-cache.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { publicImageUrls } from "../storage/storage.js";
import { getTagsForImages } from "../tags/query.js";
import { displayUrlForOriginalComparison, hasDistinctOriginalUrl } from "./original-link.js";

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
  storage_slug?: string;
  is_link?: boolean;

  author?: string | null;
  title?: string | null;
  description?: string | null;
  source?: string | null;
  original?: string | null;
  status: string;
  deleted_at?: string | Date | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
};

export type PublicImage = Awaited<ReturnType<typeof publicImage>>;

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
    expires_at: new Date(row.expires_at).toISOString()
  };
}

export async function publicImage(row: ImageRecord, tags?: string[]) {
  const slug = row.storage_slug ?? "local";
  const isLink = Boolean(row.is_link);
  const urls = await publicImageUrls(row.object_key, slug, isLink, isLink ? { id: row.id, device: row.device, brightness: row.brightness, theme: row.theme, ext: row.ext } : undefined);
  const original = row.original ?? "";
  const hasDistinctOriginal = hasDistinctOriginalUrl(
    original,
    await displayUrlForOriginalComparison({ object_key: row.object_key, storage_slug: slug, is_link: isLink })
  );

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
    storage_slug: slug,
    is_link: isLink,
    title: row.title ?? "",
    description: row.description ?? "",
    source: row.source ?? "",
    original,
    has_distinct_original: hasDistinctOriginal,
    status: row.status,
    tags: tagList,
    deleted_at: row.deleted_at ?? null,
    created_at: row.created_at ?? null,
    ...urls
  };
}

export async function publicImages(rows: ImageRecord[]) {
  const tagMap = await getTagsForImages(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => publicImage(row, tagMap.get(row.id) ?? [])));
}

export type PublicListImage = ReturnType<typeof publicListImage>;

export function publicListImage(image: PublicImage) {
  return {
    id: image.id,
    device: image.device,
    brightness: image.brightness,
    theme: image.theme,
    author: image.author,
    width: image.width,
    height: image.height,
    title: image.title,
    description: image.description,
    source: image.source,
    original: image.original,
    has_distinct_original: image.has_distinct_original,
    tags: image.tags,
    md5: image.md5,
    storage_slug: image.storage_slug,
    is_link: image.is_link,
    created_at: image.created_at,
    object_url: image.object_url,
    thumb_url: image.thumb_url
  };
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

export function publicImagesCacheKey(q: { status: string; d?: string; b?: string; t?: string; tag?: string; a?: string; cursor?: string; limit: number }) {
  return [
    `status=${q.status}`,
    `d=${q.d ?? ""}`,
    `b=${q.b ?? ""}`,
    `t=${q.t ?? ""}`,
    `tag=${q.tag ?? ""}`,
    `a=${q.a ?? ""}`,
    `cursor=${q.cursor ?? ""}`,
    `limit=${q.limit}`
  ].map((part) => encodeURIComponent(part)).join("&");
}

export async function cacheImageLookups(items: PublicImage[]) {
  const lookups = [];
  for (const item of items) {

    if (item.is_link) continue;
    lookups.push({
      object_key: item.object_key,
      thumb_key: thumbnailObjectKey(item.object_key),
      ext: item.ext,
      slug: item.storage_slug
    });
  }
  await setImageLookups(lookups);
}
