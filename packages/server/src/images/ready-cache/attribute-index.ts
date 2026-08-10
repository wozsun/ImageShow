import { logger } from "../../core/logger.ts";
import {
  publicReadUsesFallbackAdmission,
  runPublicReadBackgroundTask
} from "../../core/public-query-gateway.ts";
import { redis } from "../../core/redis-client.ts";
import { buildReadyImageAttributeIndex } from "./attribute-index-builder.ts";
import {
  readReadyImageAttributeIndex,
  type ReadyImageAttributeIndex
} from "./attribute-index-store.ts";
import { ReadyImageCoreCacheError } from "./cache-errors.ts";
import { getReadyImageCacheCoordinatorStatus } from "./coordinator.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./derived-cache-policy.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  readyImageAttributeIndexKey,
  readyImageAttributeIndexSpec,
  type ReadyImageAttributeIndexSpec
} from "./keys.ts";

export type { ReadyImageAttributeIndex } from "./attribute-index-store.ts";
export { readReadyImageAttributeIndex } from "./attribute-index-store.ts";

const ATTRIBUTE_INDEX_BUILD_MAX_CONCURRENCY = 1;

type ReadyImageAttributeIndexBuildTask = {
  controller: AbortController;
  promise: Promise<ReadyImageAttributeIndex | null>;
  waiters: number;
  settled: boolean;
  keepAlive: boolean;
};

let activeAttributeIndexBuilds = 0;
let attributeIndexBackgroundTail: Promise<void> = Promise.resolve();
const attributeIndexBuildSlotWaiters = new Set<() => void>();
const attributeIndexBuildTasks = new Map<
  string,
  ReadyImageAttributeIndexBuildTask
>();

async function buildAttributeIndex(
  spec: ReadyImageAttributeIndexSpec,
  revision: string,
  signal?: AbortSignal,
  waitForSlot = false
) {
  if (waitForSlot) {
    while (
      activeAttributeIndexBuilds >= ATTRIBUTE_INDEX_BUILD_MAX_CONCURRENCY
    ) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const available = () => {
          cleanup();
          resolve();
        };
        const aborted = () => {
          cleanup();
          reject(signal?.reason ?? new Error(
            "Attribute index build wait aborted"
          ));
        };
        const cleanup = () => {
          attributeIndexBuildSlotWaiters.delete(available);
          signal?.removeEventListener("abort", aborted);
        };
        attributeIndexBuildSlotWaiters.add(available);
        signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  } else if (
    activeAttributeIndexBuilds >= ATTRIBUTE_INDEX_BUILD_MAX_CONCURRENCY
  ) {
    return null;
  }
  signal?.throwIfAborted();
  activeAttributeIndexBuilds += 1;
  try {
    return await buildReadyImageAttributeIndex(spec, revision, signal);
  } finally {
    activeAttributeIndexBuilds -= 1;
    const waiters = [...attributeIndexBuildSlotWaiters];
    attributeIndexBuildSlotWaiters.clear();
    waiters.forEach((notify) => notify());
  }
}

function enqueueBackgroundAttributeIndexBuild(
  signal: AbortSignal,
  build: () => Promise<ReadyImageAttributeIndex | null>
) {
  return new Promise<ReadyImageAttributeIndex | null>((resolve, reject) => {
    setImmediate(() => {
      const queued = attributeIndexBackgroundTail.then(() => {
        signal.throwIfAborted();
        return runPublicReadBackgroundTask("aggregate", signal, build);
      });
      attributeIndexBackgroundTail = queued.then(
        () => undefined,
        () => undefined
      );
      queued.then(resolve, reject);
    });
  });
}

function waitForAttributeIndexBuild(
  task: ReadyImageAttributeIndexBuildTask,
  signal?: AbortSignal
) {
  if (!signal) return task.promise;
  signal.throwIfAborted();
  return new Promise<ReadyImageAttributeIndex | null>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new Error("Attribute index wait aborted"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    task.promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}

function attributeIndexBuildTask(
  taskKey: string,
  spec: ReadyImageAttributeIndexSpec,
  revision: string,
  background: boolean
) {
  const existing = attributeIndexBuildTasks.get(taskKey);
  if (existing) {
    if (background) existing.keepAlive = true;
    return existing;
  }
  if (
    attributeIndexBuildTasks.size
      >= READY_IMAGE_DERIVED_CACHE_POLICY.maxResults
  ) {
    return null;
  }

  const controller = new AbortController();
  let task!: ReadyImageAttributeIndexBuildTask;
  const build = (waitForSlot = false) => buildAttributeIndex(
    spec,
    revision,
    controller.signal,
    waitForSlot
  );
  const started = background
    ? enqueueBackgroundAttributeIndexBuild(
        controller.signal,
        () => build(true)
      )
    : build();
  const promise = started.catch((error) => {
    if (!controller.signal.aborted) {
      logger.warn("ready_image_attribute_index_build_failed", {
        key: readyImageAttributeIndexKey(spec),
        revision,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  }).finally(() => {
    task.settled = true;
    if (attributeIndexBuildTasks.get(taskKey) === task) {
      attributeIndexBuildTasks.delete(taskKey);
    }
  });
  task = {
    controller,
    promise,
    waiters: 0,
    settled: false,
    keepAlive: background
  };
  attributeIndexBuildTasks.set(taskKey, task);
  return task;
}

export async function resolveReadyImageAttributeIndex(
  key: string,
  revision: string,
  signal?: AbortSignal
): Promise<ReadyImageAttributeIndex | null> {
  const spec = readyImageAttributeIndexSpec(key);
  if (!spec || readyImageAttributeIndexKey(spec) !== key) return null;
  signal?.throwIfAborted();
  try {
    const cached = await readReadyImageAttributeIndex(key, revision);
    signal?.throwIfAborted();
    if (cached) return cached;
    const buildKey = `${key}:${revision}`;
    const background = publicReadUsesFallbackAdmission();
    const task = attributeIndexBuildTask(
      buildKey,
      spec,
      revision,
      background
    );
    if (!task) return null;
    if (background) return null;
    task.waiters += 1;
    try {
      return await waitForAttributeIndexBuild(task, signal);
    } finally {
      task.waiters -= 1;
      if (!task.keepAlive && !task.settled && task.waiters === 0) {
        task.controller.abort(
          new Error("Ready-image attribute index build has no active waiters")
        );
      }
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
}

export async function ensureReadyImageAttributeIndexes(
  keys: Iterable<string>,
  revision: string,
  signal?: AbortSignal
) {
  const indexes = new Map<string, ReadyImageAttributeIndex>();
  const background = publicReadUsesFallbackAdmission();
  let missing = false;
  for (const key of new Set(keys)) {
    const index = await resolveReadyImageAttributeIndex(key, revision, signal);
    if (!index) {
      if (!background) return null;
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
    !status.readable
    || status.meta?.state !== "ready"
    || status.meta.appliedRevision !== revision
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
        throw new ReadyImageCoreCacheError(
          "Ready-image core index cardinality differs from meta"
        );
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
