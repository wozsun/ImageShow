import type { PublicDatabaseReadAccess } from "../../core/database/public-fallback.ts";
import { readReadyImageById } from "../ready-cache/query.ts";
import type { ReadyImageCacheItem } from "../ready-cache/model.ts";

type StoredImageServingRecord = {
  id: string;
  storage_slug: string;
};

export type ImageServingRecord = StoredImageServingRecord & {
  original: string;
  updated_at: string;
};

export type ImageServingRecordDependencies = {
  readReadyImageById: typeof readReadyImageById;
};

const defaultImageServingRecordDependencies: ImageServingRecordDependencies = {
  readReadyImageById
};

function storedImageServingRecord(item: ReadyImageCacheItem): StoredImageServingRecord {
  return {
    id: item.id,
    storage_slug: item.storage_slug
  };
}

export async function readImageServingRecordById(
  id: string,
  database: Required<PublicDatabaseReadAccess>,
  dependencies: ImageServingRecordDependencies = defaultImageServingRecordDependencies
): Promise<ImageServingRecord | null> {
  const cached = await dependencies.readReadyImageById(id);
  if (cached.cached && cached.value) {
    return {
      ...storedImageServingRecord(cached.value),
      original: cached.value.original,
      updated_at: cached.value.updated_at
    };
  }
  const row = (await database.reader.query<ImageServingRecord>(
    `SELECT id, original, storage_slug, updated_at::text AS updated_at
       FROM metadata
      WHERE id=$1 AND status IN ('ready', 'deleted')
      LIMIT 1`,
    [id]
  )).rows[0];
  return row ?? null;
}
