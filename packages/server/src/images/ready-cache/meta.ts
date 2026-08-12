import type { Redis } from "ioredis";
import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import { READY_IMAGE_META_KEY } from "./keys.ts";
import {
  READY_IMAGE_CACHE_SCHEMA,
  type ReadyImageCacheMeta,
  type ReadyImageCacheState
} from "./model.ts";

const metaFields = new Set([
  "schema",
  "state",
  "applied_revision",
  "item_count",
  "last_updated_at",
  "full_rebuild_started_at",
  "full_rebuild_completed_at",
  "processed",
  "total",
  "last_full_rebuild_core_memory_bytes",
  "last_full_rebuild_measured_at",
  "last_error"
]);
const cacheStates = new Set<ReadyImageCacheState>([
  "ready",
  "rebuilding",
  "degraded"
]);

function decimalRevision(value: unknown) {
  const revision = String(value ?? "");
  if (!/^\d+$/.test(revision)) {
    throw new Error("Ready-image cache meta contains an invalid revision");
  }
  return revision;
}

function nonNegativeInteger(value: unknown, field: string) {
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Ready-image cache meta contains invalid ${field}`);
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Ready-image cache meta ${field} is outside the safe range`);
  }
  return number;
}

function optionalMemoryBytes(value: unknown) {
  return String(value ?? "") === "-1"
    ? null
    : nonNegativeInteger(value, "last_full_rebuild_core_memory_bytes");
}

function optionalTimestamp(value: unknown, field: string) {
  const timestamp = String(value ?? "");
  if (timestamp && !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Ready-image cache meta contains invalid ${field}`);
  }
  return timestamp;
}

function parseReadyImageCacheMeta(
  raw: Record<string, string>
): ReadyImageCacheMeta | null {
  if (!Object.keys(raw).length) return null;
  if (
    Object.keys(raw).length !== metaFields.size
    || Object.keys(raw).some((field) => !metaFields.has(field))
  ) {
    throw new Error("Ready-image cache meta has an unsupported shape");
  }
  const state = raw.state as ReadyImageCacheState;
  if (!cacheStates.has(state)) {
    throw new Error("Ready-image cache meta contains an invalid state");
  }
  const meta: ReadyImageCacheMeta = {
    schema: nonNegativeInteger(raw.schema, "schema"),
    state,
    appliedRevision: decimalRevision(raw.applied_revision),
    itemCount: nonNegativeInteger(raw.item_count, "item_count"),
    lastUpdatedAt: optionalTimestamp(raw.last_updated_at, "last_updated_at"),
    fullRebuildStartedAt: optionalTimestamp(
      raw.full_rebuild_started_at,
      "full_rebuild_started_at"
    ),
    fullRebuildCompletedAt: optionalTimestamp(
      raw.full_rebuild_completed_at,
      "full_rebuild_completed_at"
    ),
    processed: nonNegativeInteger(raw.processed, "processed"),
    total: nonNegativeInteger(raw.total, "total"),
    lastFullRebuildCoreMemoryBytes: optionalMemoryBytes(
      raw.last_full_rebuild_core_memory_bytes
    ),
    lastFullRebuildMeasuredAt: optionalTimestamp(
      raw.last_full_rebuild_measured_at,
      "last_full_rebuild_measured_at"
    ),
    lastError: raw.last_error
  };
  if (meta.processed > meta.total) {
    throw new Error("Ready-image cache progress exceeds its total");
  }
  if (!meta.lastUpdatedAt || !meta.fullRebuildStartedAt) {
    throw new Error("Ready-image cache meta is missing required timestamps");
  }
  if (
    meta.fullRebuildCompletedAt
    && Date.parse(meta.fullRebuildCompletedAt)
      < Date.parse(meta.fullRebuildStartedAt)
  ) {
    throw new Error(
      "Ready-image cache full rebuild timestamps are out of order"
    );
  }
  if (
    (meta.lastFullRebuildCoreMemoryBytes === null)
    !== (meta.lastFullRebuildMeasuredAt === "")
  ) {
    throw new Error("Ready-image cache memory snapshot is incomplete");
  }
  if (meta.state === "ready" && (
    !meta.fullRebuildCompletedAt
    || meta.processed !== 0
    || meta.total !== 0
    || meta.lastError
  )) {
    throw new Error("Ready-image cache ready meta is internally inconsistent");
  }
  if (meta.state === "rebuilding" && (
    meta.fullRebuildCompletedAt
    || meta.itemCount !== meta.processed
  )) {
    throw new Error("Ready-image cache rebuilding meta is internally inconsistent");
  }
  if (meta.state === "degraded" && (
    meta.fullRebuildCompletedAt
    || meta.itemCount !== 0
    || meta.processed !== 0
    || meta.total !== 0
    || !meta.lastError
  )) {
    throw new Error("Ready-image cache degraded meta is internally inconsistent");
  }
  return meta;
}

function serializedMeta(meta: ReadyImageCacheMeta) {
  if (meta.schema !== READY_IMAGE_CACHE_SCHEMA) {
    throw new Error("Refusing to write an unsupported ready-image cache schema");
  }
  return {
    schema: String(meta.schema),
    state: meta.state,
    applied_revision: decimalRevision(meta.appliedRevision),
    item_count: String(meta.itemCount),
    last_updated_at: meta.lastUpdatedAt,
    full_rebuild_started_at: meta.fullRebuildStartedAt,
    full_rebuild_completed_at: meta.fullRebuildCompletedAt,
    processed: String(meta.processed),
    total: String(meta.total),
    last_full_rebuild_core_memory_bytes:
      meta.lastFullRebuildCoreMemoryBytes === null
        ? "-1"
        : String(meta.lastFullRebuildCoreMemoryBytes),
    last_full_rebuild_measured_at: meta.lastFullRebuildMeasuredAt,
    last_error: meta.lastError.slice(0, 1_000)
  };
}

export async function readReadyImageCacheMeta(
  client: Redis = redis
): Promise<ReadyImageCacheMeta | null> {
  return parseReadyImageCacheMeta(await client.hgetall(READY_IMAGE_META_KEY));
}

export async function writeReadyImageCacheMeta(
  meta: ReadyImageCacheMeta,
  client: Redis = redis
) {
  const transaction = client.multi();
  transaction.del(READY_IMAGE_META_KEY);
  transaction.hset(READY_IMAGE_META_KEY, serializedMeta(meta));
  await execRedisPipeline(transaction);
}

export function rebuildingReadyImageCacheMeta(
  appliedRevision: string,
  startedAt = new Date().toISOString(),
  previous: ReadyImageCacheMeta | null = null
): ReadyImageCacheMeta {
  const reliablePrevious = previous?.schema === READY_IMAGE_CACHE_SCHEMA
    ? previous
    : null;
  return {
    schema: READY_IMAGE_CACHE_SCHEMA,
    state: "rebuilding",
    appliedRevision: decimalRevision(appliedRevision),
    itemCount: 0,
    lastUpdatedAt: startedAt,
    fullRebuildStartedAt: startedAt,
    fullRebuildCompletedAt: "",
    processed: 0,
    total: 0,
    lastFullRebuildCoreMemoryBytes:
      reliablePrevious?.lastFullRebuildCoreMemoryBytes ?? null,
    lastFullRebuildMeasuredAt:
      reliablePrevious?.lastFullRebuildMeasuredAt ?? "",
    lastError: ""
  };
}
