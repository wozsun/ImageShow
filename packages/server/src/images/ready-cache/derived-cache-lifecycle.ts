import { redis } from "../../core/redis-client.ts";
import {
  assertReadyImageDerivedResult,
  recordDerivedCacheModification
} from "./derived-cache-common.ts";
import {
  clearReadyImageDisposableCachesUnchecked
} from "./derived-cache-cleanup.ts";
import {
  forgetReadyImageDerivedOccupancy,
  rememberReadyImageDerivedOccupancy
} from "./derived-cache-occupancy.ts";
import {
  READY_IMAGE_DERIVED_CACHE_POLICY,
  type ReadyImageDerivedResultKind
} from "./derived-cache-policy.ts";
import {
  evictReadyImageDerivedResults,
  registerReadyImageDerivedResultUnchecked
} from "./derived-cache-registry.ts";
import {
  touchReadyImageIndexedResultUnchecked,
  touchReadyImageStatsResultUnchecked
} from "./derived-cache-touch.ts";

let derivedCacheLifecycleTail: Promise<void> = Promise.resolve();

async function withDerivedCacheLifecycle<T>(work: () => Promise<T>) {
  const previous = derivedCacheLifecycleTail;
  let release: () => void = () => undefined;
  derivedCacheLifecycleTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function clearAfterLifecycleFailure() {
  const modified = await clearReadyImageDisposableCachesUnchecked()
    .catch(() => false);
  if (modified) await recordDerivedCacheModification().catch(() => undefined);
}

async function normalizedTouchResult(result: unknown) {
  const numeric = Number(result);
  if (numeric === -1) {
    if (await clearReadyImageDisposableCachesUnchecked()) {
      await recordDerivedCacheModification();
    }
    return false;
  }
  return numeric === 1;
}

export async function registerReadyImageDerivedResult(options: {
  key: string;
  kind: ReadyImageDerivedResultKind;
  count: number;
  itemCount: number;
}) {
  return withDerivedCacheLifecycle(async () => {
    try {
      const retained = await registerReadyImageDerivedResultUnchecked(options);
      await recordDerivedCacheModification();
      return retained;
    } catch (error) {
      await clearAfterLifecycleFailure();
      throw error;
    }
  });
}

async function touchReadyImageIndexedResult(options: {
  key: string;
  kind: "attribute" | "filter";
  revision: string;
  count: number;
  itemCount: number;
  instanceToken: string;
  accessedAt: string;
}) {
  return withDerivedCacheLifecycle(async () => {
    try {
      const touched = await normalizedTouchResult(
        await touchReadyImageIndexedResultUnchecked(options)
      );
      if (touched) {
        rememberReadyImageDerivedOccupancy({
          key: options.key,
          kind: options.kind,
          count: options.count
        });
      } else {
        forgetReadyImageDerivedOccupancy([options.key]);
      }
      return touched;
    } catch (error) {
      await clearAfterLifecycleFailure();
      throw error;
    }
  });
}

export function touchReadyImageAttributeResult(options: {
  key: string;
  revision: string;
  count: number;
  itemCount: number;
  instanceToken: string;
  accessedAt: string;
}) {
  return touchReadyImageIndexedResult({ ...options, kind: "attribute" });
}

export function touchReadyImageFilterResult(options: {
  key: string;
  revision: string;
  count: number;
  itemCount: number;
  instanceToken: string;
}) {
  return touchReadyImageIndexedResult({
    ...options,
    kind: "filter",
    accessedAt: ""
  });
}

export async function touchReadyImageStatsResult(
  key: string,
  serialized: string,
  itemCount: number
) {
  return withDerivedCacheLifecycle(async () => {
    try {
      const touched = await normalizedTouchResult(
        await touchReadyImageStatsResultUnchecked(key, serialized, itemCount)
      );
      if (touched) {
        rememberReadyImageDerivedOccupancy({
          key,
          kind: "stats-result",
          count: 0
        });
      } else {
        forgetReadyImageDerivedOccupancy([key]);
      }
      return touched;
    } catch (error) {
      await clearAfterLifecycleFailure();
      throw error;
    }
  });
}

export async function discardReadyImageDerivedResult(
  key: string,
  kind?: ReadyImageDerivedResultKind
) {
  assertReadyImageDerivedResult(key, kind);
  return withDerivedCacheLifecycle(async () => {
    let modified = false;
    try {
      modified = await evictReadyImageDerivedResults([key]);
    } catch (error) {
      let cleared = false;
      await clearReadyImageDisposableCachesUnchecked().then(
        (result) => {
          cleared = true;
          modified = result;
        },
        () => undefined
      );
      if (!cleared) throw error;
    }
    if (modified) await recordDerivedCacheModification();
    return modified;
  });
}

export async function storeReadyImageStatsResult(
  key: string,
  serialized: string,
  itemCount: number
) {
  assertReadyImageDerivedResult(key, "stats-result");
  return withDerivedCacheLifecycle(async () => {
    try {
      if (
        Buffer.byteLength(serialized, "utf8")
          > READY_IMAGE_DERIVED_CACHE_POLICY.maxStatsResultBytes
      ) {
        if (await evictReadyImageDerivedResults([key])) {
          await recordDerivedCacheModification();
        }
        return false;
      }
      await redis.set(
        key,
        serialized,
        "EX",
        READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds
      );
      const retained = await registerReadyImageDerivedResultUnchecked({
        key,
        kind: "stats-result",
        count: 0,
        itemCount
      });
      await recordDerivedCacheModification();
      return retained;
    } catch (error) {
      await clearAfterLifecycleFailure();
      throw error;
    }
  });
}

export function clearReadyImageDisposableCaches() {
  return withDerivedCacheLifecycle(async () => {
    const modified = await clearReadyImageDisposableCachesUnchecked();
    if (modified) await recordDerivedCacheModification();
    return modified;
  });
}
