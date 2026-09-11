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

type StoredImageServingRecord = {
  object_key: string;
  ext: string;
  storage_slug: string;
};

export type ImageServingRecord = StoredImageServingRecord & {
  original: string;
  updated_at: string;
};

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

function storedImageServingRecord(
  item: ReadyImageCacheItem
): StoredImageServingRecord {
  return {
    object_key: item.object_key,
    ext: item.ext,
    storage_slug: item.storage_slug
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
    return {
      ...storedImageServingRecord(cached.value),
      original: cached.value.original,
      updated_at: cached.value.updated_at
    };
  }
  const row = await readDatabase(database, async (reader) => (
    (await reader.query<ImageServingRecord>(
      `SELECT object_key, original, ext, storage_slug, updated_at::text AS updated_at
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
    return storedImageServingRecord(cached.value);
  }

  const row = await readDatabase(database, async (reader) => (
    (await reader.query<StoredImageServingRecord>(
      `SELECT object_key, ext, storage_slug
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
    return storedImageServingRecord(cached.value);
  }

  const row = await readDatabase(database, async (reader) => (
    (await reader.query<StoredImageServingRecord>(
      `SELECT object_key, ext, storage_slug
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
