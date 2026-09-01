import { redis } from "../../../core/redis/client.ts";
import {
  touchReadyImageIndexedResultCommand,
  touchReadyImageStatsResultCommand,
  type RedisDerivedRegistryCommandConfig
} from "../redis/commands.ts";
import {
  assertReadyImageDerivedResult,
  nextDerivedAccessScore,
  nonNegativeInteger
} from "./common.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./policy.ts";
import {
  READY_IMAGE_ATTRIBUTE_AXIS_SUFFIXES,
  READY_IMAGE_ATTRIBUTE_SLUG_MAX_LENGTH,
  READY_IMAGE_DERIVED_INDEX_PREFIX,
  READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
  READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY,
  READY_IMAGE_FILTER_KEY_PREFIX,
  READY_IMAGE_NAMED_ATTRIBUTE_KINDS,
  READY_IMAGE_STATS_RESULT_KEY_PREFIX
} from "../keys.ts";

const derivedRegistryCommandConfig = {
  keys: [
    READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
    READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
    READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
    READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY
  ],
  ttlSeconds: READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds,
  maxResults: READY_IMAGE_DERIVED_CACHE_POLICY.maxResults,
  attributeIndexPrefix: READY_IMAGE_DERIVED_INDEX_PREFIX,
  attributeAxisSuffixes: READY_IMAGE_ATTRIBUTE_AXIS_SUFFIXES,
  namedAttributeKinds: READY_IMAGE_NAMED_ATTRIBUTE_KINDS,
  attributeSlugMaxLength: READY_IMAGE_ATTRIBUTE_SLUG_MAX_LENGTH,
  filterKeyPrefix: READY_IMAGE_FILTER_KEY_PREFIX,
  statsResultKeyPrefix: READY_IMAGE_STATS_RESULT_KEY_PREFIX,
  maxResultMembers: READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers,
  minimumTotalMembers: READY_IMAGE_DERIVED_CACHE_POLICY.minimumTotalMembers,
  totalMemberMultiplier: READY_IMAGE_DERIVED_CACHE_POLICY.totalMemberMultiplier,
  maxActiveSignatures: READY_IMAGE_DERIVED_CACHE_POLICY.maxActiveSignatures,
  maxStatsResultBytes: READY_IMAGE_DERIVED_CACHE_POLICY.maxStatsResultBytes
} as const satisfies RedisDerivedRegistryCommandConfig;

export async function touchReadyImageIndexedResultUnchecked(options: {
  key: string;
  kind: "attribute" | "filter";
  revision: string;
  count: number;
  itemCount: number;
  instanceToken: string;
  accessedAt: string;
}) {
  const descriptor = assertReadyImageDerivedResult(options.key, options.kind);
  if (!descriptor.metaKey) {
    throw new Error(
      `Ready-image derived ${options.kind} result has no metadata key`
    );
  }
  if (
    nonNegativeInteger(options.count) === null
    || nonNegativeInteger(options.itemCount) === null
    || !/^[0-9a-f]{32}$/u.test(options.instanceToken)
  ) {
    return 0;
  }
  return touchReadyImageIndexedResultCommand(redis, {
    descriptor: {
      ...descriptor,
      metaKey: descriptor.metaKey
    },
    registry: derivedRegistryCommandConfig,
    revision: options.revision,
    count: options.count,
    itemCount: options.itemCount,
    instanceToken: options.instanceToken,
    accessedAt: options.accessedAt,
    accessScore: nextDerivedAccessScore()
  });
}

export async function touchReadyImageStatsResultUnchecked(
  key: string,
  serialized: string,
  itemCount: number
) {
  const descriptor = assertReadyImageDerivedResult(key, "stats-result");
  if (nonNegativeInteger(itemCount) === null) return 0;
  return touchReadyImageStatsResultCommand(redis, {
    descriptor,
    registry: derivedRegistryCommandConfig,
    serialized,
    itemCount,
    accessScore: nextDerivedAccessScore()
  });
}
