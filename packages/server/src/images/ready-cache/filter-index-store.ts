import { getRedisConnectionState, redis } from "../../core/redis-client.ts";
import {
  storeReadyImageFilterSetCommand,
  type ReadyImageFilterSetOperation
} from "../../core/redis-business-commands.ts";
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

function currentRevision() {
  const status = getReadyImageCacheCoordinatorStatus();
  return status.readable && status.meta?.state === "ready"
    ? status.meta.appliedRevision
    : null;
}

export async function storeReadyImageFilterSetOperation(
  command: ReadyImageFilterSetOperation,
  destination: string,
  sources: Array<{ key: string; count: number }>,
  expectedMembers: number
) {
  return storeReadyImageFilterSetCommand(redis, {
    command,
    destination,
    sources,
    expectedMembers,
    temporaryTtlSeconds:
      READY_IMAGE_DERIVED_CACHE_POLICY.temporaryTtlSeconds
  });
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
