import { logger } from "../../../core/logger.ts";
import { redis } from "../../../core/redis/client.ts";
import { buildReadyImageAttributeIndex } from "./attribute-builder.ts";
import {
  readReadyImageAttributeIndex,
  type ReadyImageAttributeIndex
} from "./attribute-store.ts";
import { ReadyImageCoreCacheError } from "../cache-errors.ts";
import { getReadyImageCacheCoordinatorStatus } from "../coordinator.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "../derived/policy.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  readyImageAttributeIndexKey,
  readyImageAttributeIndexSpec,
  type ReadyImageAttributeIndexSpec
} from "../keys.ts";

export type { ReadyImageAttributeIndex } from "./attribute-store.ts";
export { readReadyImageAttributeIndex } from "./attribute-store.ts";

// Builds run one at a time on this queue; requests never wait for them.
let attributeIndexBuildTail: Promise<void> = Promise.resolve();
const pendingAttributeIndexBuilds = new Set<string>();

function scheduleAttributeIndexBuild(
  key: string,
  spec: ReadyImageAttributeIndexSpec,
  revision: string
) {
  const buildKey = `${key}:${revision}`;
  if (pendingAttributeIndexBuilds.has(buildKey)
    || pendingAttributeIndexBuilds.size >= READY_IMAGE_DERIVED_CACHE_POLICY.maxResults) {
    return;
  }
  pendingAttributeIndexBuilds.add(buildKey);
  setImmediate(() => {
    attributeIndexBuildTail = attributeIndexBuildTail
      .then(() => buildReadyImageAttributeIndex(spec, revision))
      .then(
        () => undefined,
        (error: unknown) => {
          logger.warn("ready_image_attribute_index_build_failed", {
            key,
            revision,
            error: error
          });
        }
      )
      .finally(() => {
        pendingAttributeIndexBuilds.delete(buildKey);
      });
  });
}

/**
 * Returns the published index. A missing index is scheduled for a background
 * build; null means no usable index for this request.
 */
export async function resolveReadyImageAttributeIndex(
  key: string,
  revision: string,
  signal: AbortSignal
): Promise<ReadyImageAttributeIndex | null> {
  const spec = readyImageAttributeIndexSpec(key);
  if (!spec || readyImageAttributeIndexKey(spec) !== key) return null;
  signal.throwIfAborted();
  try {
    const cached = await readReadyImageAttributeIndex(key, revision);
    signal.throwIfAborted();
    if (cached) return cached;
    scheduleAttributeIndexBuild(key, spec, revision);
    return null;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return null;
  }
}

/** Schedules every missing index and returns null unless all are published. */
export async function ensureReadyImageAttributeIndexes(
  keys: Iterable<string>,
  revision: string,
  signal: AbortSignal
) {
  const indexes = new Map<string, ReadyImageAttributeIndex>();
  let missing = false;
  for (const key of new Set(keys)) {
    const index = await resolveReadyImageAttributeIndex(
      key,
      revision,
      signal
    );
    if (!index) {
      missing = true;
      continue;
    }
    indexes.set(key, index);
  }
  return missing ? null : indexes;
}

export type ReadyImageSourceIndexState = {
  count: number;
  instanceToken: string | null;
};

export async function readReadyImageSourceIndexStates(
  keys: Iterable<string>,
  revision: string
) {
  const status = getReadyImageCacheCoordinatorStatus();
  if (
    !status.readable ||
    status.meta?.state !== "ready" ||
    status.meta.appliedRevision !== revision
  ) {
    return null;
  }
  const states = new Map<string, ReadyImageSourceIndexState>();
  for (const key of new Set(keys)) {
    if (key === READY_IMAGE_ALL_INDEX_KEY) {
      let count: number;
      try {
        count = await redis.zcard(key);
      } catch (cause) {
        throw new ReadyImageCoreCacheError(
          "Ready-image core index could not be read",
          { cause }
        );
      }
      if (count !== status.meta.itemCount) {
        throw new ReadyImageCoreCacheError("Ready-image core index cardinality differs from meta");
      }
      states.set(key, { count, instanceToken: null });
      continue;
    }
    const index = await readReadyImageAttributeIndex(key, revision);
    if (!index) return null;
    states.set(key, {
      count: index.count,
      instanceToken: index.instanceToken
    });
  }
  return states;
}
