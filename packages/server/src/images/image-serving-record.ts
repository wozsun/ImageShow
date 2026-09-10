import { pool, type DatabaseReader } from "../core/database/pools.ts";
import type {
  PublicDatabaseReadAccess
} from "../core/database/public-fallback.ts";
import {
  readReadyImageById,
  readReadyImageByObjectKey,
  readReadyImageByThumbKey
} from "./ready-cache/query.ts";
import type { ReadyImageCacheItem } from "./ready-cache/model.ts";

export type ImageServingRecord = {
  id: string;
  object_key: string;
  original: string;
  ext: string;
  storage_slug: string;
  device: "pc" | "mb";
  brightness: "dark" | "light";
  theme: string | null;
  status: "ready" | "deleted";
  description: string;
  source: string;
  updated_at: string;
};

type StoredImageServingRecord = Pick<
  ImageServingRecord,
  "id" | "object_key" | "ext" | "storage_slug" | "status"
>;

export type ImageServingRecordDependencies = {
  readReadyImageById: typeof readReadyImageById;
  readReadyImageByObjectKey: typeof readReadyImageByObjectKey;
  readReadyImageByThumbKey: typeof readReadyImageByThumbKey;
};

const defaultImageServingRecordDependencies: ImageServingRecordDependencies = {
  readReadyImageById,
  readReadyImageByObjectKey,
  readReadyImageByThumbKey
};

function readDatabase<T>(
  access: PublicDatabaseReadAccess,
  read: (reader: DatabaseReader) => Promise<T>
) {
  return read(access.reader ?? pool);
}

function readyImageServingRecord(
  item: ReadyImageCacheItem
): ImageServingRecord {
  return {
    id: item.id,
    object_key: item.object_key,
    original: item.original,
    ext: item.ext,
    storage_slug: item.storage_slug,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    status: "ready",
    description: item.description,
    source: item.source,
    updated_at: item.updated_at
  };
}

export async function readImageServingRecordById(
  id: string,
  database: PublicDatabaseReadAccess = {},
  dependencies: ImageServingRecordDependencies =
    defaultImageServingRecordDependencies
): Promise<ImageServingRecord | null> {
  const cached = await dependencies.readReadyImageById(id);
  if (cached.cached && cached.value) {
    return readyImageServingRecord(cached.value);
  }
  const row = await readDatabase(database, async (reader) => (
    (await reader.query<ImageServingRecord>(
      `SELECT id, object_key, original, ext, storage_slug, device, brightness, theme,
              status, description, source, updated_at::text AS updated_at
         FROM metadata
        WHERE id=$1
          AND status IN ('ready', 'deleted')
        LIMIT 1`,
      [id]
    )).rows[0]
  ));
  return row ?? null;
}

export async function readImageServingRecordByObjectKey(
  objectKey: string,
  database: PublicDatabaseReadAccess = {},
  dependencies: ImageServingRecordDependencies =
    defaultImageServingRecordDependencies
): Promise<StoredImageServingRecord | null> {
  const cached = await dependencies.readReadyImageByObjectKey(objectKey);
  if (cached.cached && cached.value) {
    return readyImageServingRecord(cached.value);
  }

  const row = await readDatabase(database, async (reader) => (
    (await reader.query<StoredImageServingRecord>(
      `SELECT id, object_key, ext, storage_slug, status
         FROM metadata
        WHERE object_key=$1
          AND status IN ('ready', 'deleted')
        LIMIT 1`,
      [objectKey]
    )).rows[0]
  ));
  return row ?? null;
}

export async function readImageServingRecordByThumbKey(
  thumbKey: string,
  database: PublicDatabaseReadAccess = {},
  dependencies: ImageServingRecordDependencies =
    defaultImageServingRecordDependencies
): Promise<StoredImageServingRecord | null> {
  const cached = await dependencies.readReadyImageByThumbKey(thumbKey);
  if (cached.cached && cached.value) {
    return readyImageServingRecord(cached.value);
  }

  const row = await readDatabase(database, async (reader) => (
    (await reader.query<StoredImageServingRecord>(
      `SELECT id, object_key, ext, storage_slug, status
         FROM metadata
        WHERE (object_key=$1
           OR regexp_replace(object_key, '\\.[^/.]+$', '.webp')=$1)
          AND status IN ('ready', 'deleted')
        LIMIT 1`,
      [thumbKey]
    )).rows[0]
  ));
  return row ?? null;
}
