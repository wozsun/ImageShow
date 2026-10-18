import { randomUUIDv7 } from "node:crypto";
import { unsetSelector } from "@imageshow/shared/browser";
import { withTransactionOnClient } from "../../../core/database/transactions.ts";
import { neverAbortedSignal } from "../../../core/abort.ts";
import type { DatabaseReader } from "../../../core/database/pools.ts";
import { withPublicDatabaseRead } from "../../../core/database/public-fallback.ts";
import { getRedisConnectionState, redis } from "../../../core/redis/client.ts";
import { execRedisPipeline } from "../../../core/redis/pipeline.ts";
import { getReadyImageCacheCoordinatorStatus } from "../coordinator.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "../derived/policy.ts";
import { parseNonNegativeInteger } from "../derived/registry-metadata.ts";
import {
  READY_IMAGE_DERIVED_INDEX_PREFIX,
  READY_IMAGE_STATS_KEY,
  readyImageAttributeIndexKey,
  readyImageAttributeIndexTemporaryKey,
  type ReadyImageAttributeIndexSpec
} from "../keys.ts";
import {
  readyImageMember,
  readyImageTimeScore
} from "../model.ts";
import { chunkSortedSetEntries } from "../sync/redis-batch.ts";
import { getReadyImageRevision } from "../revision.ts";
import {
  publishReadyImageAttributeIndex,
  type ReadyImageAttributeIndex
} from "./attribute-store.ts";

const ATTRIBUTE_INDEX_BATCH_SIZE = 1_000;

type ReadyImageAttributeIndexRow = {
  id: string;
};

/** Every attribute source pages by ascending image ID; scores derive from the ID. */
function attributeSourceQuery(
  spec: ReadyImageAttributeIndexSpec,
  afterId: string | null
) {
  if ((spec.kind === "tag" && spec.value !== unsetSelector) || spec.kind === "group") {
    const table = spec.kind === "tag" ? "image_tag" : "image_group_member";
    const slugColumn = spec.kind === "tag" ? "tag_slug" : "group_slug";
    return {
      text: `SELECT m.id::text AS id
               FROM ${table} it
               JOIN metadata m ON m.id=it.image_id
              WHERE it.${slugColumn}=$1
                AND m.status='ready'
                AND ($2::uuid IS NULL OR it.image_id > $2::uuid)
              ORDER BY it.image_id
              LIMIT $3`,
      values: [spec.value, afterId, ATTRIBUTE_INDEX_BATCH_SIZE]
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
  } else if (spec.kind === "tag") {
    conditions.push("NOT EXISTS (SELECT 1 FROM image_tag it WHERE it.image_id=m.id)");
  } else {
    conditions.push(
      (spec.kind === "theme" || spec.kind === "author") && spec.value === unsetSelector
        ? `m.${spec.kind} IS NULL`
        : `m.${spec.kind}=${bind(spec.value)}`
    );
  }
  const id = bind(afterId);
  values.push(ATTRIBUTE_INDEX_BATCH_SIZE);
  return {
    text: `SELECT m.id::text AS id
             FROM metadata m
            WHERE ${conditions.join(" AND ")}
              AND (${id}::uuid IS NULL OR m.id > ${id}::uuid)
            ORDER BY m.id
            LIMIT $${values.length}`,
    values
  };
}

async function readAttributeIndexBatch(
  client: DatabaseReader,
  spec: ReadyImageAttributeIndexSpec,
  afterId: string | null,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const query = attributeSourceQuery(spec, afterId);
  const rows = (await client.query(query.text, query.values)).rows as ReadyImageAttributeIndexRow[];
  signal.throwIfAborted();
  return rows;
}

async function writeAttributeIndexBatch(
  key: string,
  rows: ReadyImageAttributeIndexRow[],
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const entries = rows.map(
    (row) => [readyImageTimeScore(row), readyImageMember(row.id)] as const
  );
  for (const chunk of chunkSortedSetEntries(key, entries)) {
    const members = chunk.flat();
    const transaction = redis.multi();
    transaction.zadd(key, ...members);
    transaction.expire(
      key,
      READY_IMAGE_DERIVED_CACHE_POLICY.temporaryTtlSeconds
    );
    await execRedisPipeline(transaction);
    signal.throwIfAborted();
  }
}

async function buildAttributeIndexSource(
  client: DatabaseReader,
  spec: ReadyImageAttributeIndexSpec,
  revision: string,
  temporaryKey: string,
  connectionEpoch: number,
  signal: AbortSignal
) {
  let count = 0;
  let afterId: string | null = null;
  return withTransactionOnClient(client, async () => {
    if ((await getReadyImageRevision(client)).revision !== revision) {
      return null;
    }
    for (;;) {
      signal.throwIfAborted();
      const rows = await readAttributeIndexBatch(client, spec, afterId, signal);
      if (!rows.length) break;
      if (count + rows.length > READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers) {
        return null;
      }
      await writeAttributeIndexBatch(temporaryKey, rows, signal);
      count += rows.length;
      if (!Number.isSafeInteger(count)) {
        throw new Error("Ready-image attribute index is too large");
      }
      const lastId = rows.at(-1)!.id;
      if (lastId === afterId) {
        throw new Error("Ready-image attribute index keyset cursor did not advance");
      }
      afterId = lastId;
      const connection = getRedisConnectionState();
      if (!connection.ready || connection.epoch !== connectionEpoch) {
        throw new Error("Redis connection changed while building an attribute index");
      }
      if (rows.length < ATTRIBUTE_INDEX_BATCH_SIZE) break;
    }
    signal.throwIfAborted();
    return count;
  }, { mode: "read_only_repeatable_read" });
}

/**
 * Background-only: the build holds a public read admission like any other
 * public fallback, and no request waits for it.
 */
export async function buildReadyImageAttributeIndex(
  spec: ReadyImageAttributeIndexSpec,
  revision: string
): Promise<ReadyImageAttributeIndex | null> {
  const status = getReadyImageCacheCoordinatorStatus();
  const startingMeta = status.meta;
  const connection = getRedisConnectionState();
  if (
    !status.readable ||
    startingMeta?.state !== "ready" ||
    startingMeta.appliedRevision !== revision ||
    !connection.ready
  ) {
    return null;
  }
  const statField = readyImageAttributeIndexKey(spec).slice(
    READY_IMAGE_DERIVED_INDEX_PREFIX.length
  );
  const expectedCount = parseNonNegativeInteger(await redis.hget(READY_IMAGE_STATS_KEY, statField));
  // Avoid reading and materializing an index that registration cannot retain.
  // The keyset loop independently enforces the cap on the source snapshot.
  if (expectedCount !== null && expectedCount > READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers) {
    return null;
  }
  const temporaryKey = readyImageAttributeIndexTemporaryKey(randomUUIDv7().replaceAll("-", ""));
  try {
    return await withPublicDatabaseRead(neverAbortedSignal, async ({ reader }, signal) => {
      const count = await buildAttributeIndexSource(
        reader,
        spec,
        revision,
        temporaryKey,
        connection.epoch,
        signal
      );
      signal.throwIfAborted();
      if (count === null) return null;
      const cardinality = await redis.zcard(temporaryKey);
      signal.throwIfAborted();
      if (cardinality !== count) {
        throw new Error("Ready-image attribute index cardinality differs from its source");
      }
      return publishReadyImageAttributeIndex({
        spec,
        revision,
        count,
        temporaryKey,
        startingMeta,
        connectionEpoch: connection.epoch,
        signal,
        reader
      });
    });
  } finally {
    await redis.unlink(temporaryKey).catch(() => undefined);
  }
}
