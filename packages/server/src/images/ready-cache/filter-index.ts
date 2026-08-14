import { coalesce } from "../../core/coalesce.ts";
import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  requireOperationalRedis,
  runRequiredRedisCommand
} from "../../core/runtime-availability.ts";
import type { ImageFilterPlan } from "../filter-plan.ts";
import {
  readReadyImageAttributeIndex,
  resolveReadyImageAttributeIndex
} from "./attribute-index.ts";
import {
  ReadyImageCoreCacheError,
  isReadyImageCoreCacheError
} from "./cache-errors.ts";
import {
  getReadyImageCacheCoordinatorStatus,
  readyImageCacheIsReadable
} from "./coordinator.ts";
import { discardReadyImageDerivedResult } from "./derived-cache-lifecycle.ts";
import {
  buildReadyImageFilterIndex,
  resolveDirectReadyImageFilterKey
} from "./filter-index-builder.ts";
import {
  readReadyImageFilterIndex,
  validatePublishedReadyImageFilterIndex,
  type ReadyImageFilterIndex as FilterIndex
} from "./filter-index-store.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_INTEGRITY_KEY,
  readyImageFilterKey
} from "./keys.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";

export type ReadyImageFilterIndex = FilterIndex;

export type ReadyImageFilterIndexValidation =
  | "valid"
  | "revision_changed"
  | "invalid";

type ReadyImageFilterIndexResolution =
  | {
      mode: "fallback";
      signal?: AbortSignal;
      background: boolean;
    }
  | {
      mode: "required";
    };

function currentRevision() {
  const status = getReadyImageCacheCoordinatorStatus();
  return status.readable && status.meta?.state === "ready"
    ? status.meta.appliedRevision
    : null;
}

async function resolveReadyImageFilterIndexWithMode(
  plan: ImageFilterPlan,
  options: ReadyImageFilterIndexResolution
): Promise<ReadyImageFilterIndex | null> {
  const required = options.mode === "required";
  const signal = options.mode === "fallback" ? options.signal : undefined;
  const direct = resolveDirectReadyImageFilterKey(plan);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    if (required) await requireOperationalRedis();
    if (!readyImageCacheIsReadable()) {
      if (required) await requireOperationalRedis();
      return null;
    }
    const revision = currentRevision();
    if (!revision) {
      if (required) await requireOperationalRedis();
      return null;
    }
    if (direct === READY_IMAGE_ALL_INDEX_KEY) {
      const status = getReadyImageCacheCoordinatorStatus();
      if (status.meta?.appliedRevision !== revision) continue;
      return {
        kind: "core",
        key: direct,
        revision,
        count: status.meta.itemCount,
        metaKey: null,
        instanceToken: null
      };
    }
    if (direct) {
      const attribute = required
        ? await runRequiredRedisCommand(() => (
            readReadyImageAttributeIndex(direct, revision)
          ))
        : await resolveReadyImageAttributeIndex(
            direct,
            revision,
            signal,
            options.background
          );
      if (currentRevision() !== revision) continue;
      if (attribute) return { kind: "attribute", ...attribute };
      if (required) {
        scheduleReadyImageFilterIndexBuild(plan);
        return null;
      }
      continue;
    }
    const cached = required
      ? await runRequiredRedisCommand(() => (
          readReadyImageFilterIndex(plan.signature, revision)
        ))
      : await readReadyImageFilterIndex(plan.signature, revision);
    if (currentRevision() !== revision) continue;
    if (cached) return cached;
    if (required) {
      scheduleReadyImageFilterIndexBuild(plan);
      return null;
    }
    const built = await coalesce(
      `ready-image-filter:${plan.signature}`,
      () => buildReadyImageFilterIndex(
        plan,
        revision,
        signal,
        options.background
      )
    );
    if (currentRevision() !== revision) continue;
    if (built) return built;
  }
  return null;
}

export async function resolveReadyImageFilterIndex(
  plan: ImageFilterPlan,
  signal?: AbortSignal,
  background = false
): Promise<ReadyImageFilterIndex | null> {
  try {
    return await resolveReadyImageFilterIndexWithMode(plan, {
      mode: "fallback",
      signal,
      background
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isReadyImageCoreCacheError(error)) throw error;
    recordReadyImageCacheError(
      "derived",
      "derived_filter_build_failed",
      error
    );
    await discardReadyImageDerivedResult(
      readyImageFilterKey(plan.signature),
      "filter"
    ).catch(() => undefined);
    logger.warn("ready_image_derived_filter_failed", {
      signature: plan.signature,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function scheduleReadyImageFilterIndexBuild(plan: ImageFilterPlan) {
  void resolveReadyImageFilterIndex(plan, undefined, true).catch(() => undefined);
}

/**
 * Resolves only already-published indexes for an admin request. Every Redis
 * read that belongs to the response is strict; a cache miss schedules the
 * existing derived-index builder outside the response and permits the caller
 * to use its PostgreSQL fallback.
 */
export async function resolveReadyImageFilterIndexForRequiredRead(
  plan: ImageFilterPlan
): Promise<ReadyImageFilterIndex | null> {
  return resolveReadyImageFilterIndexWithMode(plan, { mode: "required" });
}

export async function validateReadyImageFilterIndex(
  index: ReadyImageFilterIndex
): Promise<ReadyImageFilterIndexValidation> {
  if (currentRevision() !== index.revision) return "revision_changed";
  if (index.kind === "core") {
    const transaction = redis.pipeline();
    transaction.hget(READY_IMAGE_INTEGRITY_KEY, index.key);
    transaction.zcard(index.key);
    let results: Awaited<ReturnType<typeof execRedisPipeline>>;
    try {
      results = await execRedisPipeline(transaction);
    } catch (cause) {
      throw new ReadyImageCoreCacheError(
        "Ready-image core index could not be validated",
        { cause }
      );
    }
    const expectedRaw = results[0]?.[1];
    const actual = Number(results[1]?.[1] ?? 0);
    if (!Number.isSafeInteger(actual) || actual < 0) return "invalid";
    if (expectedRaw === null) return "invalid";
    const expected = Number(expectedRaw);
    return Number.isSafeInteger(expected) && expected >= 0 && expected === actual
      ? "valid"
      : "invalid";
  }
  if (index.kind === "attribute") {
    const current = await readReadyImageAttributeIndex(
      index.key,
      index.revision,
      false
    );
    return current
      && current.metaKey === index.metaKey
      && current.count === index.count
      && current.instanceToken === index.instanceToken
      ? "valid"
      : "invalid";
  }
  return await validatePublishedReadyImageFilterIndex(index)
    ? "valid"
    : "invalid";
}
