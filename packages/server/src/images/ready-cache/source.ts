import type { Pool, PoolClient } from "pg";
import { pool } from "../../core/db.ts";
import {
  READY_IMAGE_REBUILD_BATCH_SIZE,
  readyImageCacheItemFromRow,
  type ReadyImageCacheItem
} from "./model.ts";
import { getReadyImageRevision } from "./revision.ts";

export type ReadyImageSourceSnapshot = {
  revision: string;
  total: number;
  processed: number;
};

export const readyImageSourceColumns = `m.id::text AS id,
  m.object_key,
  m.ext,
  m.device,
  m.brightness,
  m.theme,
  m.storage_slug,
  COALESCE(m.author, '') AS author,
  COALESCE((
    SELECT array_agg(it.tag_slug ORDER BY it.tag_slug)
      FROM image_tag it
     WHERE it.image_id=m.id
  ), '{}'::text[]) AS tags,
  m.width,
  m.height,
  m.image_size,
  to_char(
    m.image_time AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS cursor_image_time,
  (extract(epoch FROM m.image_time) * 1000000)::bigint::text AS sort_score,
  m.title,
  m.description,
  m.source,
  m.original,
  m.md5,
  to_char(
    m.created_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS cursor_created_at,
  to_char(
    m.updated_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS cursor_updated_at`;

export async function readReadyImageSourceItems(
  ids: readonly string[],
  executor: Pool | PoolClient = pool,
  signal?: AbortSignal
) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  signal?.throwIfAborted();
  const rows = (await executor.query(
    `SELECT ${readyImageSourceColumns}
       FROM metadata m
      WHERE m.status='ready' AND m.id=ANY($1::uuid[])
      ORDER BY m.id`,
    [uniqueIds]
  )).rows as Record<string, unknown>[];
  signal?.throwIfAborted();
  return rows.map(readyImageCacheItemFromRow);
}

async function readBatch(
  client: PoolClient,
  afterId: string | null,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const rows = (await client.query(
    `SELECT ${readyImageSourceColumns}
       FROM metadata m
      WHERE m.status='ready'
        AND ($1::uuid IS NULL OR m.id > $1::uuid)
      ORDER BY m.id
      LIMIT $2`,
    [afterId, READY_IMAGE_REBUILD_BATCH_SIZE]
  )).rows as Record<string, unknown>[];
  signal?.throwIfAborted();
  return rows.map(readyImageCacheItemFromRow);
}

export async function readReadyImageSourceSnapshot(
  onStart: (snapshot: Omit<ReadyImageSourceSnapshot, "processed">) => Promise<void>,
  onBatch: (
    items: ReadyImageCacheItem[],
    snapshot: ReadyImageSourceSnapshot
  ) => Promise<void>,
  signal?: AbortSignal
): Promise<ReadyImageSourceSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const revision = (await getReadyImageRevision(client)).revision;
    const total = Number((await client.query(
      "SELECT count(*)::int AS count FROM metadata WHERE status='ready'"
    )).rows[0]?.count ?? 0);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error("PostgreSQL returned an invalid ready-image count");
    }
    await onStart({ revision, total });
    let afterId: string | null = null;
    let processed = 0;
    for (;;) {
      signal?.throwIfAborted();
      const items = await readBatch(client, afterId, signal);
      if (!items.length) break;
      processed += items.length;
      await onBatch(items, { revision, total, processed });
      afterId = items.at(-1)?.id ?? null;
      if (items.length < READY_IMAGE_REBUILD_BATCH_SIZE) break;
    }
    if (processed !== total) {
      throw new Error("Ready-image cache source count changed inside snapshot");
    }
    await client.query("COMMIT");
    return { revision, total, processed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
