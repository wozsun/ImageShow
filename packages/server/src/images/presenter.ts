import { adminApiBasePath, type Brightness, type Device } from "@imageshow/shared";
import { setImageLookups } from "../core/redis.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { publicImageUrls } from "../storage/storage.js";
import { getTagsForImages } from "../tags/query.js";

export type ImageRecord = {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  category_key: string;
  category_index: number;
  index_key: string;
  width?: number | string | null;
  height?: number | string | null;
  ext: string;
  md5?: string | null;
  object_key: string;
  storage_slug?: string;
  is_link?: boolean;
  // Optional single author slug (FK -> author.slug), NULL when unset. Resolved to a display
  // name + link on the client via the gallery facets, like theme.
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

export type UploadSessionRecord = {
  id: string;
  status: string;
  expires_at: string | Date;
};

// Every upload streams through this server (browser → server → backend), so the
// target is always the same same-origin endpoint regardless of which backend the
// session is pinned to. The browser PUTs there with the admin session cookie and
// CSRF header — see docs/guide/flows for why we don't presign direct-to-S3 PUTs.
export function uploadSessionResponse(row: UploadSessionRecord) {
  return {
    id: row.id,
    status: row.status,
    upload_url: `${adminApiBasePath}/uploads/${row.id}/file`,
    expires_at: new Date(row.expires_at).toISOString()
  };
}

export async function publicImage(row: ImageRecord, tags?: string[]) {
  const slug = row.storage_slug ?? "local";
  const isLink = Boolean(row.is_link);
  const urls = await publicImageUrls(row.object_key, slug, isLink, isLink ? { id: row.id, device: row.device, brightness: row.brightness, theme: row.theme, ext: row.ext } : undefined);
  // Single-image callers (e.g. fetch/edit one) let this fetch its own tags; list
  // callers pass a pre-fetched batch (publicImages) to avoid a per-row query.
  const tagList = tags ?? (await getTagsForImages([row.id])).get(row.id) ?? [];
  return {
    id: row.id,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    author: row.author ?? "",
    category_index: row.category_index,
    index_key: row.index_key,
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    ext: row.ext,
    md5: row.md5 ?? "",
    object_key: row.object_key,
    storage_slug: slug,
    is_link: isLink,
    title: row.title ?? "",
    description: row.description ?? "",
    source: row.source ?? "",
    original: row.original ?? "",
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

// The public gallery list (/api/images) is unauthenticated, so it should only carry what
// the gallery grid + its detail modal actually render — not every metadata column. This is
// an explicit allowlist (so a new column added to publicImage never silently leaks): it
// drops the fields that appear in no public/detail view — object_key (internal storage path),
// category_key, status, updated_at, ext, and deleted_at (the list is ready-only, so it would
// always be null). It deliberately keeps md5 / storage_slug / is_link / created_at, which the
// detail modal shows to a logged-in admin browsing the public gallery (admin=true). Applied on
// egress in listPublicImages, after cacheImageLookups has read object_key/slug/ext off the full
// objects.
export type PublicListImage = ReturnType<typeof publicListImage>;

export function publicListImage(image: PublicImage) {
  return {
    id: image.id,
    device: image.device,
    brightness: image.brightness,
    theme: image.theme,
    author: image.author,
    category_index: image.category_index,
    index_key: image.index_key,
    width: image.width,
    height: image.height,
    title: image.title,
    description: image.description,
    source: image.source,
    original: image.original,
    tags: image.tags,
    md5: image.md5,
    storage_slug: image.storage_slug,
    is_link: image.is_link,
    created_at: image.created_at,
    object_url: image.object_url,
    thumb_url: image.thumb_url
  };
}

// Admin-facing projection of a PublicImage for the management lists / detail / dedup check.
// Two jobs: (1) drop `ext`, an internal field the admin UI never reads (it only exists for
// server-side thumbnail-key derivation); (2) for a recycle-bin (deleted) image, repoint its
// URLs at the authenticated admin byte endpoints — the public static/link hosts now refuse
// deleted images (see images/serving.ts), so the trash view streams them through the server.
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
    // Link images resolve their thumbnail (link.<domain>/thumbs) and proxied original
    // (link.<domain>/media) by id at serve time, so they need no object/thumb lookup entry.
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
