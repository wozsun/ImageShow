import type { PoolClient } from "pg";
import { withPublicReadClient } from "../../core/public-pg-fallback.ts";
import { getRedisConnectionState, redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { getReadyImageCacheCoordinatorStatus } from "./coordinator.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./derived-cache-policy.ts";
import {
  readyImageAttributeIndexTemporaryKey,
  type ReadyImageAttributeIndexSpec
} from "./keys.ts";
import {
  readyImageMember,
  readyImageSortScore
} from "./model.ts";
import { chunkSortedSetEntries } from "./redis-batch.ts";
import { getReadyImageRevision } from "./revision.ts";
import {
  publishReadyImageAttributeIndex,
  type ReadyImageAttributeIndex
} from "./attribute-index-store.ts";

const ATTRIBUTE_INDEX_BATCH_SIZE = 1_000;

type ReadyImageAttributeIndexRow = {
  id: string;
  sort_score: string;
  cursor_image_time?: string;
};

type ReadyImageAttributeIndexCursor = {
  id: string;
  imageTime?: string;
};

function attributeSourceQuery(
  spec: ReadyImageAttributeIndexSpec,
  cursor: ReadyImageAttributeIndexCursor | null
) {
  const commonColumns = `m.id::text AS id,
    (extract(epoch FROM m.image_time) * 1000000)::bigint::text AS sort_score`;
  if (spec.kind === "tag") {
    return {
      text: `SELECT ${commonColumns}
               FROM image_tag it
               JOIN metadata m ON m.id=it.image_id
              WHERE it.tag_slug=$1
                AND m.status='ready'
                AND ($2::uuid IS NULL OR it.image_id > $2::uuid)
              ORDER BY it.image_id
              LIMIT $3`,
      values: [spec.value, cursor?.id ?? null, ATTRIBUTE_INDEX_BATCH_SIZE]
    };
  }
  const conditions: string[] = ["m.status='ready'"];
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (spec.kind === "axis") {
    conditions.push(`m.device=${bind(spec.device)}`);
    conditions.push(`m.brightness=${bind(spec.brightness)}`);
  } else {
    conditions.push(`m.${spec.kind}=${bind(spec.value)}`);
  }
  const time = bind(cursor?.imageTime ?? null);
  const id = bind(cursor?.id ?? null);
  values.push(ATTRIBUTE_INDEX_BATCH_SIZE);
  return {
    text: `SELECT ${commonColumns},
                  to_char(
                    m.image_time AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  ) AS cursor_image_time
             FROM metadata m
            WHERE ${conditions.join(" AND ")}
              AND (${time}::timestamptz IS NULL
                OR (m.image_time, m.id) < (${time}::timestamptz, ${id}::uuid))
            ORDER BY m.image_time DESC, m.id DESC
            LIMIT $${values.length}`,
    values
  };
}

async function readAttributeIndexBatch(
  client: PoolClient,
  spec: ReadyImageAttributeIndexSpec,
  cursor: ReadyImageAttributeIndexCursor | null,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const query = attributeSourceQuery(spec, cursor);
  const rows = (await client.query(query.text, query.values))
    .rows as ReadyImageAttributeIndexRow[];
  signal?.throwIfAborted();
  return rows;
}

async function writeAttributeIndexBatch(
  key: string,
  rows: ReadyImageAttributeIndexRow[],
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const entries = rows.map((row) => (
    [readyImageSortScore(row.sort_score), readyImageMember(row.id)] as const
  ));
  for (const chunk of chunkSortedSetEntries(key, entries)) {
    const members = chunk.flat();
    const transaction = redis.multi();
    transaction.zadd(key, ...members);
    transaction.expire(
      key,
      READY_IMAGE_DERIVED_CACHE_POLICY.temporaryTtlSeconds
    );
    await execRedisPipeline(transaction);
    signal?.throwIfAborted();
  }
}

async function buildAttributeIndexSource(
  client: PoolClient,
  spec: ReadyImageAttributeIndexSpec,
  revision: string,
  temporaryKey: string,
  connectionEpoch: number,
  signal?: AbortSignal
) {
  let count = 0;
  let cursor: ReadyImageAttributeIndexCursor | null = null;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if ((await getReadyImageRevision(client)).revision !== revision) {
      await client.query("ROLLBACK");
      return null;
    }
    for (;;) {
      signal?.throwIfAborted();
      const rows = await readAttributeIndexBatch(client, spec, cursor, signal);
      if (!rows.length) break;
      await writeAttributeIndexBatch(temporaryKey, rows, signal);
      count += rows.length;
      if (!Number.isSafeInteger(count)) {
        throw new Error("Ready-image attribute index is too large");
      }
      const last = rows.at(-1)!;
      if (
        spec.kind !== "tag"
        && !Number.isFinite(Date.parse(last.cursor_image_time ?? ""))
      ) {
        throw new Error("Ready-image attribute index cursor is invalid");
      }
      const nextCursor = spec.kind === "tag"
        ? { id: last.id }
        : { id: last.id, imageTime: last.cursor_image_time };
      if (
        nextCursor.id === cursor?.id
        && nextCursor.imageTime === cursor?.imageTime
      ) {
        throw new Error("Ready-image attribute index keyset cursor did not advance");
      }
      cursor = nextCursor;
      const connection = getRedisConnectionState();
      if (!connection.ready || connection.epoch !== connectionEpoch) {
        throw new Error(
          "Redis connection changed while building an attribute index"
        );
      }
      if (rows.length < ATTRIBUTE_INDEX_BATCH_SIZE) break;
    }
    signal?.throwIfAborted();
    await client.query("COMMIT");
    return count;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function buildReadyImageAttributeIndex(
  spec: ReadyImageAttributeIndexSpec,
  revision: string,
  signal?: AbortSignal
): Promise<ReadyImageAttributeIndex | null> {
  signal?.throwIfAborted();
  const status = getReadyImageCacheCoordinatorStatus();
  const startingMeta = status.meta;
  const connection = getRedisConnectionState();
  if (
    !status.readable
    || startingMeta?.state !== "ready"
    || startingMeta.appliedRevision !== revision
    || !connection.ready
  ) {
    return null;
  }
  const temporaryKey = readyImageAttributeIndexTemporaryKey(
    randomUuidV7().replaceAll("-", "")
  );
  try {
    const count = await withPublicReadClient(async (client, publicSignal) => {
      const buildSignal = signal
        ? AbortSignal.any([signal, publicSignal])
        : publicSignal;
      return buildAttributeIndexSource(
        client,
        spec,
        revision,
        temporaryKey,
        connection.epoch,
        buildSignal
      );
    });
    signal?.throwIfAborted();
    if (count === null) return null;
    const cardinality = await redis.zcard(temporaryKey);
    signal?.throwIfAborted();
    if (cardinality !== count) {
      throw new Error(
        "Ready-image attribute index cardinality differs from its source"
      );
    }
    return await publishReadyImageAttributeIndex({
      spec,
      revision,
      count,
      temporaryKey,
      startingMeta,
      connectionEpoch: connection.epoch,
      signal
    });
  } finally {
    await redis.unlink(temporaryKey).catch(() => undefined);
  }
}
