import { coalesce } from "../../core/coalesce.ts";
import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
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

function currentRevision() {
  const status = getReadyImageCacheCoordinatorStatus();
  return status.readable && status.meta?.state === "ready"
    ? status.meta.appliedRevision
    : null;
}

export async function resolveReadyImageFilterIndex(
  plan: ImageFilterPlan,
  signal?: AbortSignal
): Promise<ReadyImageFilterIndex | null> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      if (!readyImageCacheIsReadable()) return null;
      const revision = currentRevision();
      if (!revision) return null;
      const direct = resolveDirectReadyImageFilterKey(plan);
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
        const attribute = await resolveReadyImageAttributeIndex(
          direct,
          revision,
          signal
        );
        if (attribute) return { kind: "attribute", ...attribute };
        continue;
      }
      const cached = await readReadyImageFilterIndex(plan.signature, revision);
      if (cached) return cached;
      const built = await coalesce(
        `ready-image-filter:${plan.signature}`,
        () => buildReadyImageFilterIndex(plan, revision, signal)
      );
      if (built) return built;
    }
    return null;
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
