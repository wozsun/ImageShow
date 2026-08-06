import { getRedisConnectionState, redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import {
  getReadyImageCacheCoordinatorStatus
} from "./coordinator.ts";
import {
  discardReadyImageDerivedResult,
  registerReadyImageDerivedResult,
  touchReadyImageFilterResult
} from "./derived-cache-lifecycle.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./derived-cache-policy.ts";
import { readReadyImageDerivedIndexSnapshot } from "./derived-index-snapshot.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";
import {
  readyImageFilterKey,
  readyImageFilterMetaKey
} from "./keys.ts";
import type { ReadyImageCacheMeta } from "./model.ts";
import {
  readReadyImageSourceIndexStates,
  type ReadyImageSourceIndexState
} from "./attribute-index.ts";

type ReadyImageResolvedIndex = {
  key: string;
  revision: string;
};

export type ReadyImageFilterIndex = ReadyImageResolvedIndex & (
  | { kind: "core"; count: number; metaKey: null; instanceToken: null }
  | { kind: "attribute"; count: number; metaKey: string; instanceToken: string }
  | { kind: "filter"; count: number; metaKey: string; instanceToken: string }
);

const storeSetOperationScript = `
local source_count = #KEYS - 1
for index = 1, source_count do
  local actual = redis.call('ZCARD', KEYS[index])
  if actual ~= tonumber(ARGV[index]) then
    return {0, index, actual}
  end
end

local command = ARGV[source_count + 1]
local expected = tonumber(ARGV[source_count + 2])
local ttl = tonumber(ARGV[source_count + 3])
local destination = KEYS[source_count + 1]
local arguments = {destination, tostring(source_count)}
for index = 1, source_count do
  table.insert(arguments, KEYS[index])
end
if command ~= 'ZDIFFSTORE' then
  table.insert(arguments, 'AGGREGATE')
  table.insert(arguments, 'MAX')
end
local stored = redis.call(command, unpack(arguments))
if stored > expected then
  redis.call('UNLINK', destination)
  return {-1, stored, 0}
end
local expiry = 0
if stored > 0 then
  expiry = redis.call('EXPIRE', destination, ttl)
else
  redis.call('UNLINK', destination)
end
return {1, stored, expiry, redis.call('ZCARD', destination)}
`;

function currentRevision() {
  const status = getReadyImageCacheCoordinatorStatus();
  return status.readable && status.meta?.state === "ready"
    ? status.meta.appliedRevision
    : null;
}

export async function storeReadyImageFilterSetOperation(
  command: "zunionstore" | "zinterstore" | "zdiffstore",
  destination: string,
  sources: Array<{ key: string; count: number }>,
  expectedMembers: number
) {
  const sourceKeys = sources.map(({ key }) => key);
  const raw = await redis.call(
    "EVAL",
    storeSetOperationScript,
    String(sourceKeys.length + 1),
    ...sourceKeys,
    destination,
    ...sources.map(({ count }) => String(count)),
    command.toUpperCase(),
    String(expectedMembers),
    String(READY_IMAGE_DERIVED_CACHE_POLICY.temporaryTtlSeconds)
  );
  if (!Array.isArray(raw)) {
    await redis.unlink(destination).catch(() => undefined);
    throw new Error("Ready-image derived set operation returned invalid data");
  }
  const status = Number(raw[0] ?? -2);
  const stored = Number(raw[1] ?? -1);
  const expiry = Number(raw[2] ?? -1);
  const cardinality = Number(raw[3] ?? -1);
  if (status === 0) {
    throw new Error("Ready-image derived set source changed during build");
  }
  if (
    status !== 1
    || !Number.isSafeInteger(stored)
    || stored < 0
    || !Number.isSafeInteger(cardinality)
    || cardinality < 0
    || stored !== cardinality
    || cardinality > expectedMembers
    || expiry !== (cardinality > 0 ? 1 : 0)
  ) {
    await redis.unlink(destination).catch(() => undefined);
    throw new Error("Ready-image derived set operation exceeded its estimate");
  }
  return cardinality;
}

export async function readReadyImageFilterIndex(
  signature: string,
  revision: string
): Promise<ReadyImageFilterIndex | null> {
  const key = readyImageFilterKey(signature);
  const metaKey = readyImageFilterMetaKey(signature);
  try {
    const snapshot = await readReadyImageDerivedIndexSnapshot({
      kind: "filter",
      key,
      metaKey,
      revision
    });
    if (!snapshot) {
      await discardReadyImageDerivedResult(key, "filter");
      return null;
    }
    if (!await touchReadyImageFilterResult({
      key,
      revision,
      count: snapshot.count,
      itemCount: snapshot.itemCount,
      instanceToken: snapshot.instanceToken
    })) {
      await discardReadyImageDerivedResult(key, "filter");
      return null;
    }
    return {
      kind: "filter",
      key,
      revision,
      count: snapshot.count,
      metaKey,
      instanceToken: snapshot.instanceToken
    };
  } catch (error) {
    await discardReadyImageDerivedResult(key, "filter").catch(() => undefined);
    throw error;
  }
}

export async function publishReadyImageFilterIndex(options: {
  signature: string;
  revision: string;
  count: number;
  temporaryKey: string;
  startingMeta: ReadyImageCacheMeta;
  connectionEpoch: number;
  sourceKeys: string[];
  sourceStates: Map<string, ReadyImageSourceIndexState>;
  signal?: AbortSignal;
}): Promise<ReadyImageFilterIndex | null> {
  const finalKey = readyImageFilterKey(options.signature);
  const metaKey = readyImageFilterMetaKey(options.signature);
  options.signal?.throwIfAborted();
  const cardinality = await redis.zcard(options.temporaryKey);
  if (cardinality !== options.count) {
    throw new Error("Ready-image filter result changed before publication");
  }
  let publishedInstanceToken: string | null;
  try {
    publishedInstanceToken = await withReadyImageCacheWriteFence(async () => {
      const status = getReadyImageCacheCoordinatorStatus();
      const connection = getRedisConnectionState();
      if (
        !status.readable
        || status.meta?.state !== "ready"
        || status.meta !== options.startingMeta
        || status.meta.appliedRevision !== options.revision
        || !connection.ready
        || connection.epoch !== options.connectionEpoch
      ) {
        return null;
      }
      const publishedSourceStates = await readReadyImageSourceIndexStates(
        options.sourceKeys,
        options.revision
      );
      if (
        !publishedSourceStates
        || [...options.sourceStates].some(([key, sourceState]) => (
          publishedSourceStates.get(key)?.count !== sourceState.count
          || publishedSourceStates.get(key)?.instanceToken
            !== sourceState.instanceToken
        ))
      ) {
        return null;
      }
      const instanceToken = randomUuidV7().replaceAll("-", "");
      const transaction = redis.multi();
      transaction.del(finalKey, metaKey);
      if (options.count > 0) {
        transaction.rename(options.temporaryKey, finalKey);
        transaction.expire(
          finalKey,
          READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds
        );
      }
      transaction.hset(metaKey, {
        applied_revision: options.revision,
        count: String(options.count),
        built_at: new Date().toISOString(),
        instance_token: instanceToken
      });
      transaction.expire(
        metaKey,
        READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds
      );
      await execRedisPipeline(transaction);
      const retained = await registerReadyImageDerivedResult({
        key: finalKey,
        kind: "filter",
        count: options.count,
        itemCount: status.meta.itemCount
      });
      if (!retained || currentRevision() !== options.revision) {
        await discardReadyImageDerivedResult(finalKey, "filter");
        return null;
      }
      return instanceToken;
    });
  } catch (error) {
    await discardReadyImageDerivedResult(finalKey, "filter")
      .catch(() => undefined);
    throw error;
  }
  if (!publishedInstanceToken) {
    await discardReadyImageDerivedResult(finalKey, "filter")
      .catch(() => undefined);
    return null;
  }
  const snapshot = await readReadyImageDerivedIndexSnapshot({
    kind: "filter",
    key: finalKey,
    metaKey,
    revision: options.revision,
    expected: {
      count: options.count,
      instanceToken: publishedInstanceToken
    }
  });
  if (!snapshot) {
    await discardReadyImageDerivedResult(finalKey, "filter")
      .catch(() => undefined);
    return null;
  }
  return {
    kind: "filter",
    key: finalKey,
    revision: options.revision,
    count: options.count,
    metaKey,
    instanceToken: snapshot.instanceToken
  };
}

export async function validatePublishedReadyImageFilterIndex(
  index: Extract<ReadyImageFilterIndex, { kind: "filter" }>
) {
  try {
    const valid = Boolean(await readReadyImageDerivedIndexSnapshot({
      kind: "filter",
      key: index.key,
      metaKey: index.metaKey,
      revision: index.revision,
      expected: {
        count: index.count,
        instanceToken: index.instanceToken
      }
    }));
    if (!valid) await discardReadyImageDerivedResult(index.key, "filter");
    return valid;
  } catch (error) {
    await discardReadyImageDerivedResult(index.key, "filter")
      .catch(() => undefined);
    throw error;
  }
}
