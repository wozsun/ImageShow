import type { Brightness, Device } from "@imageshow/shared";
import { setImageLookups } from "../core/redis.js";
import type { StorageBackend } from "../config/settings.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { createUploadTarget, publicImageUrls } from "../storage/storage.js";

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
  storage_backend?: StorageBackend;
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
  staging_object_key: string;
  expected_size: number | string;
  storage_backend: StorageBackend;
  metadata_payload?: { md5?: string } | null;
};

export async function uploadSessionResponse(row: UploadSessionRecord) {
  const expiresAt = new Date(row.expires_at).getTime();
  const target = await createUploadTarget({
    ...row,
    expected_size: Number(row.expected_size),
    content_md5_hex: typeof row.metadata_payload?.md5 === "string" ? row.metadata_payload.md5 : undefined
  });
  return {
    id: row.id,
    status: row.status,
    upload_url: target.upload_url,
    upload_headers: target.upload_headers,
    upload_backend: target.backend,
    expires_at: new Date(expiresAt).toISOString()
  };
}

export async function publicImage(row: ImageRecord) {
  const backend: StorageBackend = row.storage_backend ?? "local";
  const urls = await publicImageUrls(row.object_key, backend);
  return {
    id: row.id,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    category_key: row.category_key,
    category_index: row.category_index,
    index_key: row.index_key,
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    ext: row.ext,
    md5: row.md5 ?? "",
    object_key: row.object_key,
    storage_backend: backend,
    title: row.title ?? "",
    description: row.description ?? "",
    source: row.source ?? "",
    original: row.original ?? "",
    status: row.status,
    deleted_at: row.deleted_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    ...urls
  };
}

export async function publicImages(rows: ImageRecord[]) {
  return Promise.all(rows.map((row) => publicImage(row)));
}

export function publicImagesCacheKey(q: { status: string; d?: string; b?: string; t?: string; cursor?: string; limit: number }) {
  return [
    `status=${q.status}`,
    `d=${q.d ?? ""}`,
    `b=${q.b ?? ""}`,
    `t=${q.t ?? ""}`,
    `cursor=${q.cursor ?? ""}`,
    `limit=${q.limit}`
  ].map((part) => encodeURIComponent(part)).join("&");
}

export async function cacheImageLookups(items: PublicImage[]) {
  const lookups = [];
  for (const item of items) {
    lookups.push({
      object_key: item.object_key,
      thumb_key: thumbnailObjectKey(item.object_key),
      ext: item.ext,
      backend: item.storage_backend
    });
  }
  await setImageLookups(lookups);
}
