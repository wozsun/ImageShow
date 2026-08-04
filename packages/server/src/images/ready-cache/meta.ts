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
  "built_at",
  "started_at",
  "processed",
  "total",
  "memory_bytes",
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
    builtAt: optionalTimestamp(raw.built_at, "built_at"),
    startedAt: optionalTimestamp(raw.started_at, "started_at"),
    processed: nonNegativeInteger(raw.processed, "processed"),
    total: nonNegativeInteger(raw.total, "total"),
    memoryBytes: nonNegativeInteger(raw.memory_bytes, "memory_bytes"),
    lastError: raw.last_error
  };
  if (meta.processed > meta.total) {
    throw new Error("Ready-image cache progress exceeds its total");
  }
  if (
    meta.state === "ready"
    && (
      meta.schema !== READY_IMAGE_CACHE_SCHEMA
      || !meta.builtAt
      || meta.itemCount !== meta.total
      || meta.processed !== meta.total
      || meta.lastError
    )
  ) {
    throw new Error("Ready-image cache ready meta is internally inconsistent");
  }
  return meta;
}

function serializedMeta(meta: ReadyImageCacheMeta) {
  return {
    schema: String(meta.schema),
    state: meta.state,
    applied_revision: decimalRevision(meta.appliedRevision),
    item_count: String(meta.itemCount),
    built_at: meta.builtAt,
    started_at: meta.startedAt,
    processed: String(meta.processed),
    total: String(meta.total),
    memory_bytes: String(meta.memoryBytes),
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
  startedAt = new Date().toISOString()
): ReadyImageCacheMeta {
  return {
    schema: READY_IMAGE_CACHE_SCHEMA,
    state: "rebuilding",
    appliedRevision: decimalRevision(appliedRevision),
    itemCount: 0,
    builtAt: "",
    startedAt,
    processed: 0,
    total: 0,
    memoryBytes: 0,
    lastError: ""
  };
}
