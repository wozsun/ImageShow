import { hash } from "node:crypto";
import { redis } from "../../../core/redis/client.ts";
import { assertReadyImageDerivedResult } from "./registry-metadata.ts";
import { clearReadyImageDisposableCachesUnchecked } from "./cleanup.ts";
import {
  READY_IMAGE_DERIVED_CACHE_POLICY,
  type ReadyImageDerivedResultKind
} from "./policy.ts";
import {
  evictReadyImageDerivedResults,
  registerReadyImageDerivedResultUnchecked
} from "./registry.ts";
import {
  touchReadyImageIndexedResultUnchecked,
  touchReadyImageStatsResultUnchecked
} from "./touch.ts";

let derivedCacheLifecycleTail: Promise<void> = Promise.resolve();

/**
 * Per-process record of the result instances whose access was registered
 * recently. Any failure, discard, re-registration or clear forgets it, so the
 * next read registers again through the lifecycle queue.
 */
const recentAccessRegistrations = new Map<string, { identity: string; registeredAtMs: number }>();

function accessRegisteredRecently(key: string, identity: string) {
  const entry = recentAccessRegistrations.get(key);
  if (entry?.identity !== identity) return false;
  const elapsedMs = Date.now() - entry.registeredAtMs;
  return elapsedMs >= 0
    && elapsedMs < READY_IMAGE_DERIVED_CACHE_POLICY.accessRegistrationIntervalMs;
}

function rememberAccessRegistration(key: string, identity: string) {
  recentAccessRegistrations.delete(key);
  recentAccessRegistrations.set(key, { identity, registeredAtMs: Date.now() });
  if (recentAccessRegistrations.size > READY_IMAGE_DERIVED_CACHE_POLICY.maxResults) {
    const oldest = recentAccessRegistrations.keys().next().value;
    if (oldest !== undefined) recentAccessRegistrations.delete(oldest);
  }
}

async function registerAccessOnce(
  key: string,
  identity: string,
  touch: () => Promise<unknown>
) {
  if (accessRegisteredRecently(key, identity)) return true;
  return withDerivedCacheLifecycle(async () => {
    if (accessRegisteredRecently(key, identity)) return true;
    recentAccessRegistrations.delete(key);
    try {
      const touched = await normalizedTouchResult(await touch());
      if (touched) rememberAccessRegistration(key, identity);
      return touched;
    } catch (error) {
      await clearAfterLifecycleFailure();
      throw error;
    }
  });
}

async function withDerivedCacheLifecycle<T>(work: () => Promise<T>) {
  const previous = derivedCacheLifecycleTail;
  const { promise, resolve: release } = Promise.withResolvers<void>();
  derivedCacheLifecycleTail = promise;
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function clearDisposableCaches() {
  recentAccessRegistrations.clear();
  return clearReadyImageDisposableCachesUnchecked();
}

async function clearAfterLifecycleFailure() {
  await clearDisposableCaches().catch(() => false);
}

async function normalizedTouchResult(result: unknown) {
  const numeric = Number(result);
  if (numeric === -1) {
    await clearDisposableCaches();
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
    recentAccessRegistrations.delete(options.key);
    try {
      return await registerReadyImageDerivedResultUnchecked(options);
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
  // accessedAt is the time written by a registration, not part of the instance.
  const identity = JSON.stringify([
    options.kind,
    options.revision,
    options.count,
    options.itemCount,
    options.instanceToken
  ]);
  return registerAccessOnce(
    options.key,
    identity,
    () => touchReadyImageIndexedResultUnchecked(options)
  );
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
  return registerAccessOnce(
    key,
    `${itemCount}:${hash("sha256", serialized, "base64url")}`,
    () => touchReadyImageStatsResultUnchecked(key, serialized, itemCount)
  );
}

export async function discardReadyImageDerivedResult(
  key: string,
  kind?: ReadyImageDerivedResultKind
) {
  assertReadyImageDerivedResult(key, kind);
  return withDerivedCacheLifecycle(async () => {
    recentAccessRegistrations.delete(key);
    let modified = false;
    try {
      modified = await evictReadyImageDerivedResults([key]);
    } catch (error) {
      let cleared = false;
      await clearDisposableCaches().then(
        (result) => {
          cleared = true;
          modified = result;
        },
        () => undefined
      );
      if (!cleared) throw error;
    }
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
    recentAccessRegistrations.delete(key);
    try {
      if (
        Buffer.byteLength(serialized, "utf8") > READY_IMAGE_DERIVED_CACHE_POLICY.maxStatsResultBytes
      ) {
        await evictReadyImageDerivedResults([key]);
        return false;
      }
      await redis.set(
        key,
        serialized,
        "EX",
        READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds
      );
      return await registerReadyImageDerivedResultUnchecked({
        key,
        kind: "stats-result",
        count: 0,
        itemCount
      });
    } catch (error) {
      await clearAfterLifecycleFailure();
      throw error;
    }
  });
}

export function clearReadyImageDisposableCaches() {
  return withDerivedCacheLifecycle(clearDisposableCaches);
}
