import type { DatabaseReader } from "../../core/database-pools.ts";
import {
  publishReadyImageAttributeIndexCommand
} from "../../core/redis-business-commands.ts";
import { getRedisConnectionState, redis } from "../../core/redis-client.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { getReadyImageCacheCoordinatorStatus } from "./coordinator.ts";
import {
  discardReadyImageDerivedResult,
  registerReadyImageDerivedResult,
  touchReadyImageAttributeResult
} from "./derived-cache-lifecycle.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./derived-cache-policy.ts";
import { readReadyImageDerivedIndexSnapshot } from "./derived-index-snapshot.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";
import {
  readyImageAttributeIndexKey,
  readyImageAttributeIndexMetaKey,
  readyImageAttributeIndexSpec,
  type ReadyImageAttributeIndexSpec
} from "./keys.ts";
import type { ReadyImageCacheMeta } from "./model.ts";
import { getReadyImageRevision } from "./revision.ts";

export type ReadyImageAttributeIndex = {
  key: string;
  metaKey: string;
  revision: string;
  count: number;
  instanceToken: string;
};

export async function readReadyImageAttributeIndex(
  key: string,
  revision: string,
  touch = true
): Promise<ReadyImageAttributeIndex | null> {
  const spec = readyImageAttributeIndexSpec(key);
  if (!spec || readyImageAttributeIndexKey(spec) !== key) return null;
  const metaKey = readyImageAttributeIndexMetaKey(key);
  try {
    const snapshot = await readReadyImageDerivedIndexSnapshot({
      kind: "attribute",
      key,
      metaKey,
      revision
    });
    if (!snapshot) {
      await discardReadyImageDerivedResult(key, "attribute");
      return null;
    }
    if (touch && !await touchReadyImageAttributeResult({
      key,
      revision,
      count: snapshot.count,
      itemCount: snapshot.itemCount,
      instanceToken: snapshot.instanceToken,
      accessedAt: new Date().toISOString()
    })) {
      await discardReadyImageDerivedResult(key, "attribute");
      return null;
    }
    return {
      key,
      metaKey,
      revision,
      count: snapshot.count,
      instanceToken: snapshot.instanceToken
    };
  } catch (error) {
    await discardReadyImageDerivedResult(key, "attribute")
      .catch(() => redis.unlink(key, metaKey).catch(() => undefined));
    throw error;
  }
}

export async function publishReadyImageAttributeIndex(options: {
  spec: ReadyImageAttributeIndexSpec;
  revision: string;
  count: number;
  temporaryKey: string;
  startingMeta: ReadyImageCacheMeta;
  connectionEpoch: number;
  signal?: AbortSignal;
  reader: DatabaseReader;
}): Promise<ReadyImageAttributeIndex | null> {
  const key = readyImageAttributeIndexKey(options.spec);
  const metaKey = readyImageAttributeIndexMetaKey(key);
  options.signal?.throwIfAborted();
  try {
    return await withReadyImageCacheWriteFence(async () => {
      options.signal?.throwIfAborted();
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
      const sourceRevision = (await getReadyImageRevision(options.reader))
        .revision;
      options.signal?.throwIfAborted();
      if (sourceRevision !== options.revision) {
        return null;
      }

      const now = new Date().toISOString();
      const instanceToken = randomUuidV7().replaceAll("-", "");
      const published = await publishReadyImageAttributeIndexCommand(redis, {
        key,
        metaKey,
        temporaryKey: options.temporaryKey,
        count: options.count,
        revision: options.revision,
        now,
        instanceToken,
        ttlSeconds: READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds
      });
      options.signal?.throwIfAborted();
      if (!published) {
        return null;
      }

      const publishedRevision = (await getReadyImageRevision(options.reader))
        .revision;
      options.signal?.throwIfAborted();
      const publishedStatus = getReadyImageCacheCoordinatorStatus();
      const publishedConnection = getRedisConnectionState();
      if (
        !publishedStatus.readable
        || publishedStatus.meta?.state !== "ready"
        || publishedStatus.meta !== options.startingMeta
        || publishedStatus.meta.appliedRevision !== options.revision
        || !publishedConnection.ready
        || publishedConnection.epoch !== options.connectionEpoch
        || publishedRevision !== options.revision
      ) {
        await redis.unlink(key, metaKey);
        return null;
      }

      const registered = await registerReadyImageDerivedResult({
        key,
        kind: "attribute",
        count: options.count,
        itemCount: options.startingMeta.itemCount
      });
      options.signal?.throwIfAborted();
      const registeredStatus = getReadyImageCacheCoordinatorStatus();
      const registeredConnection = getRedisConnectionState();
      if (
        !registered
        || !registeredStatus.readable
        || registeredStatus.meta !== options.startingMeta
        || !registeredConnection.ready
        || registeredConnection.epoch !== options.connectionEpoch
      ) {
        await discardReadyImageDerivedResult(key, "attribute");
        return null;
      }
      return {
        key,
        metaKey,
        revision: options.revision,
        count: options.count,
        instanceToken
      };
    });
  } catch (error) {
    await discardReadyImageDerivedResult(key, "attribute")
      .catch(() => redis.unlink(key, metaKey).catch(() => undefined));
    throw error;
  }
}
