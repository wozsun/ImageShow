import type {
  ClientContext,
  Redis,
  RedisValue,
  Result
} from "ioredis";

type RedisBusinessCommandName =
  | "imageshowReserveWindows"
  | "imageshowTouchReadyImageIndexedResult"
  | "imageshowTouchReadyImageStatsResult"
  | "imageshowStoreReadyImageFilterSet"
  | "imageshowPublishReadyImageAttributeIndex"
  | "imageshowSampleReadyImageCoreIndex"
  | "imageshowSampleReadyImageDerivedIndex";

type RedisBusinessClientContract = Pick<Redis, RedisBusinessCommandName>;
type RedisBusinessPipelineContract = Pick<
  ReturnType<Redis["pipeline"]>,
  RedisBusinessCommandName
>;
type RedisBusinessTransactionContract = Pick<
  ReturnType<Redis["multi"]>,
  RedisBusinessCommandName
>;

declare module "ioredis" {
  interface RedisCommander<Context extends ClientContext> {
    imageshowReserveWindows(
      numberOfKeys: number | string,
      ...arguments_: RedisValue[]
    ): Result<number[], Context>;

    imageshowTouchReadyImageIndexedResult(
      resultKey: RedisValue,
      metaKey: RedisValue,
      registryLruKey: RedisValue,
      registryCountsKey: RedisValue,
      registryKindsKey: RedisValue,
      registrySignaturesKey: RedisValue,
      registryMember: RedisValue,
      count: RedisValue,
      revision: RedisValue,
      accessedAt: RedisValue,
      ttlSeconds: RedisValue,
      instanceToken: RedisValue,
      metaFieldCount: RedisValue,
      kind: RedisValue,
      signature: RedisValue,
      accessScore: RedisValue,
      maximumResults: RedisValue,
      itemCount: RedisValue,
      attributeIndexPrefix: RedisValue,
      attributeAxisSuffixes: RedisValue,
      namedAttributeKinds: RedisValue,
      attributeSlugMaxLength: RedisValue,
      filterKeyPrefix: RedisValue,
      statsResultKeyPrefix: RedisValue,
      maximumResultMembers: RedisValue,
      minimumTotalMembers: RedisValue,
      totalMemberMultiplier: RedisValue,
      maximumActiveSignatures: RedisValue,
      maximumStatsResultBytes: RedisValue
    ): Result<number, Context>;

    imageshowTouchReadyImageStatsResult(
      resultKey: RedisValue,
      registryMember: RedisValue,
      registryLruKey: RedisValue,
      registryCountsKey: RedisValue,
      registryKindsKey: RedisValue,
      registrySignaturesKey: RedisValue,
      resultIdentity: RedisValue,
      serialized: RedisValue,
      ttlSeconds: RedisValue,
      signature: RedisValue,
      accessScore: RedisValue,
      maximumResults: RedisValue,
      itemCount: RedisValue,
      attributeIndexPrefix: RedisValue,
      attributeAxisSuffixes: RedisValue,
      namedAttributeKinds: RedisValue,
      attributeSlugMaxLength: RedisValue,
      filterKeyPrefix: RedisValue,
      statsResultKeyPrefix: RedisValue,
      maximumResultMembers: RedisValue,
      minimumTotalMembers: RedisValue,
      totalMemberMultiplier: RedisValue,
      maximumActiveSignatures: RedisValue,
      maximumStatsResultBytes: RedisValue
    ): Result<number, Context>;

    imageshowStoreReadyImageFilterSet(
      numberOfKeys: number | string,
      ...arguments_: RedisValue[]
    ): Result<number[], Context>;

    imageshowPublishReadyImageAttributeIndex(
      destinationKey: RedisValue,
      metaKey: RedisValue,
      temporaryKey: RedisValue,
      count: RedisValue,
      revision: RedisValue,
      builtAt: RedisValue,
      accessedAt: RedisValue,
      instanceToken: RedisValue,
      ttlSeconds: RedisValue
    ): Result<number, Context>;

    imageshowSampleReadyImageCoreIndex(
      metaKey: RedisValue,
      integrityKey: RedisValue,
      indexKey: RedisValue,
      itemsKey: RedisValue,
      revision: RedisValue,
      expectedCount: RedisValue,
      limit: RedisValue,
      recentSize: RedisValue,
      historySize: RedisValue,
      maximumLimit: RedisValue
    ): Result<Array<number | string | null>, Context>;

    imageshowSampleReadyImageDerivedIndex(
      coreMetaKey: RedisValue,
      integrityKey: RedisValue,
      coreIndexKey: RedisValue,
      itemsKey: RedisValue,
      derivedIndexKey: RedisValue,
      derivedMetaKey: RedisValue,
      revision: RedisValue,
      expectedCoreCount: RedisValue,
      expectedIndexCount: RedisValue,
      instanceToken: RedisValue,
      kind: RedisValue,
      limit: RedisValue,
      recentSize: RedisValue,
      historySize: RedisValue,
      maximumLimit: RedisValue,
      maximumIndexMembers: RedisValue
    ): Result<Array<number | string | null>, Context>;
  }
}

export {};
