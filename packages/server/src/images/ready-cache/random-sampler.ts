import { appConfig } from "@imageshow/shared";
import {
  sampleReadyImageCoreIndexCommand,
  sampleReadyImageDerivedIndexCommand,
  type RedisReadyImageSampleResult
} from "../../core/redis-business-commands.ts";
import { redis } from "../../core/redis-client.ts";
import { ReadyImageCoreCacheError } from "./cache-errors.ts";
import { getReadyImageCacheCoordinatorStatus } from "./coordinator.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./derived-cache-policy.ts";
import type { ReadyImageFilterIndex } from "./filter-index.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_INTEGRITY_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_META_KEY
} from "./keys.ts";
import {
  parseReadyImageCacheItem,
  readyImageMember,
  type ReadyImageCacheItem
} from "./model.ts";

type ReadyImageCoreSampleInput = Parameters<
  typeof sampleReadyImageCoreIndexCommand
>[1];
type ReadyImageDerivedSampleInput = Parameters<
  typeof sampleReadyImageDerivedIndexCommand
>[1];

type ReadyImageSampleDependencies = {
  currentRevision: () => string | null;
  coreCount: () => number;
  sampleCore: (
    input: ReadyImageCoreSampleInput
  ) => Promise<RedisReadyImageSampleResult>;
  sampleDerived: (
    input: ReadyImageDerivedSampleInput
  ) => Promise<RedisReadyImageSampleResult>;
};

function currentReadyImageRevision() {
  const status = getReadyImageCacheCoordinatorStatus();
  return status.readable && status.meta?.state === "ready"
    ? status.meta.appliedRevision
    : null;
}

function cacheItemCount() {
  return getReadyImageCacheCoordinatorStatus().meta?.itemCount ?? 0;
}

const defaultReadyImageSampleDependencies: ReadyImageSampleDependencies = {
  currentRevision: currentReadyImageRevision,
  coreCount: cacheItemCount,
  sampleCore: (input) => sampleReadyImageCoreIndexCommand(redis, input),
  sampleDerived: (input) => sampleReadyImageDerivedIndexCommand(redis, input)
};

function parsedSampleItem(raw: string | null, expectedMember: string) {
  const item = parseReadyImageCacheItem(raw);
  if (!item || readyImageMember(item.id) !== expectedMember) {
    throw new ReadyImageCoreCacheError(
      "Ready-image cache returned a corrupt core item"
    );
  }
  return item;
}

function sampledReadyImageItems(
  result: RedisReadyImageSampleResult
): ReadyImageCacheItem[] | null {
  switch (result.status) {
    case "ok":
      return result.pairs.map(({ member, value }) => (
        parsedSampleItem(value, member)
      ));
    case "empty":
      return [];
    case "revision_changed":
    case "token_changed":
      return null;
    case "core_invalid":
      throw new ReadyImageCoreCacheError(
        "Ready-image core sample validation failed"
      );
    case "core_missing_item":
      throw new ReadyImageCoreCacheError(
        "Ready-image core sample references a missing item"
      );
    case "derived_invalid":
      throw new Error("Ready-image derived sample validation failed");
    case "expired":
      throw new Error("Ready-image derived sample expired");
    case "derived_missing_item":
      throw new Error("Ready-image derived sample references a missing item");
  }
}

export async function sampleResolvedReadyImageIndex(
  index: ReadyImageFilterIndex,
  limit: number,
  recent: ReadonlySet<string>,
  dependencies: ReadyImageSampleDependencies =
    defaultReadyImageSampleDependencies
) {
  if (dependencies.currentRevision() !== index.revision) return null;
  const bounds = {
    limit,
    recentSize: Math.min(recent.size, appConfig.randomDedupe.historySize),
    historySize: appConfig.randomDedupe.historySize,
    maximumLimit: appConfig.randomQuery.maxJsonItems
  };
  const coreKeys = [
    READY_IMAGE_META_KEY,
    READY_IMAGE_INTEGRITY_KEY,
    READY_IMAGE_ALL_INDEX_KEY,
    READY_IMAGE_ITEMS_KEY
  ] as const;
  const result = index.kind === "core"
    ? await dependencies.sampleCore({
        keys: coreKeys,
        revision: index.revision,
        count: index.count,
        bounds
      })
    : await dependencies.sampleDerived({
        keys: [...coreKeys, index.key, index.metaKey],
        kind: index.kind,
        revision: index.revision,
        coreCount: dependencies.coreCount(),
        indexCount: index.count,
        instanceToken: index.instanceToken,
        maximumIndexMembers:
          READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers,
        bounds
      });
  if (dependencies.currentRevision() !== index.revision) return null;
  const items = sampledReadyImageItems(result);
  if (!items) return null;
  const fresh: ReadyImageCacheItem[] = [];
  const fallback: ReadyImageCacheItem[] = [];
  items.forEach((item) => {
    (recent.has(item.id) ? fallback : fresh).push(item);
  });
  return [...fresh, ...fallback].slice(0, limit);
}
