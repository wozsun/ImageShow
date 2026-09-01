import {
  readyImageRedisCommandClient,
  type ReadyImageRedisCommandSource
} from "./client.ts";

export type RedisIndexedTouchCommandClient = ReadyImageRedisCommandSource<
  "imageshowTouchReadyImageIndexedResult"
>;

export type RedisStatsTouchCommandClient = ReadyImageRedisCommandSource<
  "imageshowTouchReadyImageStatsResult"
>;

export type RedisFilterSetCommandClient = ReadyImageRedisCommandSource<
  "imageshowStoreReadyImageFilterSet"
> & {
  unlink(...keys: string[]): Promise<number>;
};

export type RedisAttributePublishCommandClient = ReadyImageRedisCommandSource<
  "imageshowPublishReadyImageAttributeIndex"
>;

export type RedisDerivedResultDescriptor = {
  key: string;
  kind: "attribute" | "filter" | "stats-result";
  metaKey: string | null;
  signature: string | null;
};

export type RedisDerivedRegistryCommandConfig = {
  keys: readonly [
    lru: string,
    counts: string,
    kinds: string,
    signatures: string
  ];
  ttlSeconds: number;
  maxResults: number;
  attributeIndexPrefix: string;
  attributeAxisSuffixes: readonly string[];
  namedAttributeKinds: readonly string[];
  attributeSlugMaxLength: number;
  filterKeyPrefix: string;
  statsResultKeyPrefix: string;
  maxResultMembers: number;
  minimumTotalMembers: number;
  totalMemberMultiplier: number;
  maxActiveSignatures: number;
  maxStatsResultBytes: number;
};

export type ReadyImageIndexedTouchCommandInput = {
  descriptor: RedisDerivedResultDescriptor & { metaKey: string };
  registry: RedisDerivedRegistryCommandConfig;
  revision: string;
  count: number;
  itemCount: number;
  instanceToken: string;
  accessedAt: string;
  accessScore: number;
};

function derivedRegistryValidationArguments(
  config: RedisDerivedRegistryCommandConfig
) {
  return [
    config.attributeIndexPrefix,
    config.attributeAxisSuffixes.join(","),
    config.namedAttributeKinds.join(","),
    String(config.attributeSlugMaxLength),
    config.filterKeyPrefix,
    config.statsResultKeyPrefix,
    String(config.maxResultMembers),
    String(config.minimumTotalMembers),
    String(config.totalMemberMultiplier),
    String(config.maxActiveSignatures),
    String(config.maxStatsResultBytes)
  ] as const;
}

function readyImageTouchResult(raw: unknown): -1 | 0 | 1 {
  const numeric = Number(raw);
  if (numeric === -1 || numeric === 1) return numeric;
  return 0;
}

export async function touchReadyImageIndexedResultCommand(
  client: RedisIndexedTouchCommandClient,
  input: ReadyImageIndexedTouchCommandInput
) {
  const { descriptor } = input;
  const [lruKey, countsKey, kindsKey, signaturesKey] = input.registry.keys;
  const commandClient = readyImageRedisCommandClient(
    client,
    "imageshowTouchReadyImageIndexedResult"
  );
  const raw = await commandClient.imageshowTouchReadyImageIndexedResult(
    descriptor.key,
    descriptor.metaKey,
    lruKey,
    countsKey,
    kindsKey,
    signaturesKey,
    descriptor.key,
    String(input.count),
    input.revision,
    input.accessedAt,
    String(input.registry.ttlSeconds),
    input.instanceToken,
    descriptor.kind === "attribute" ? "5" : "4",
    descriptor.kind,
    descriptor.signature ?? "",
    String(input.accessScore),
    String(input.registry.maxResults),
    String(input.itemCount),
    ...derivedRegistryValidationArguments(input.registry)
  );
  return readyImageTouchResult(raw);
}

export async function touchReadyImageStatsResultCommand(
  client: RedisStatsTouchCommandClient,
  input: {
    descriptor: RedisDerivedResultDescriptor;
    registry: RedisDerivedRegistryCommandConfig;
    serialized: string;
    itemCount: number;
    accessScore: number;
  }
) {
  const [lruKey, countsKey, kindsKey, signaturesKey] = input.registry.keys;
  const commandClient = readyImageRedisCommandClient(
    client,
    "imageshowTouchReadyImageStatsResult"
  );
  const raw = await commandClient.imageshowTouchReadyImageStatsResult(
    input.descriptor.key,
    input.descriptor.key,
    lruKey,
    countsKey,
    kindsKey,
    signaturesKey,
    input.descriptor.key,
    input.serialized,
    String(input.registry.ttlSeconds),
    input.descriptor.signature ?? "",
    String(input.accessScore),
    String(input.registry.maxResults),
    String(input.itemCount),
    ...derivedRegistryValidationArguments(input.registry)
  );
  return readyImageTouchResult(raw);
}

export type ReadyImageFilterSetOperation =
  | "zunionstore"
  | "zinterstore"
  | "zdiffstore";

export async function storeReadyImageFilterSetCommand(
  client: RedisFilterSetCommandClient,
  input: {
    command: ReadyImageFilterSetOperation;
    destination: string;
    sources: ReadonlyArray<{ key: string; count: number }>;
    expectedMembers: number;
    temporaryTtlSeconds: number;
  }
) {
  const sourceKeys = input.sources.map(({ key }) => key);
  const commandClient = readyImageRedisCommandClient(
    client,
    "imageshowStoreReadyImageFilterSet"
  );
  const raw = await commandClient.imageshowStoreReadyImageFilterSet(
    String(sourceKeys.length + 1),
    ...sourceKeys,
    input.destination,
    ...input.sources.map(({ count }) => String(count)),
    input.command.toUpperCase(),
    String(input.expectedMembers),
    String(input.temporaryTtlSeconds)
  );
  if (!Array.isArray(raw)) {
    await client.unlink(input.destination).catch(() => undefined);
    throw new Error("Ready-image derived set operation returned invalid data");
  }
  const status = Number(raw[0] ?? -2);
  const stored = Number(raw[1] ?? -1);
  const expiry = Number(raw[2] ?? -1);
  const cardinality = Number(raw[3] ?? -1);
  if (status === 0) {
    throw new Error("Ready-image derived set source changed during build");
  }
  if (
    status !== 1
    || !Number.isSafeInteger(stored)
    || stored < 0
    || !Number.isSafeInteger(cardinality)
    || cardinality < 0
    || stored !== cardinality
    || cardinality > input.expectedMembers
    || expiry !== (cardinality > 0 ? 1 : 0)
  ) {
    await client.unlink(input.destination).catch(() => undefined);
    throw new Error("Ready-image derived set operation exceeded its estimate");
  }
  return cardinality;
}

export async function publishReadyImageAttributeIndexCommand(
  client: RedisAttributePublishCommandClient,
  input: {
    key: string;
    metaKey: string;
    temporaryKey: string;
    count: number;
    revision: string;
    now: string;
    instanceToken: string;
    ttlSeconds: number;
  }
) {
  const commandClient = readyImageRedisCommandClient(
    client,
    "imageshowPublishReadyImageAttributeIndex"
  );
  const raw = await commandClient.imageshowPublishReadyImageAttributeIndex(
    input.key,
    input.metaKey,
    input.temporaryKey,
    String(input.count),
    input.revision,
    input.now,
    input.now,
    input.instanceToken,
    String(input.ttlSeconds)
  );
  return Number(raw) === 1;
}

type RedisReadyImageSampleStatus =
  | "ok"
  | "empty"
  | "core_invalid"
  | "derived_invalid"
  | "revision_changed"
  | "token_changed"
  | "expired"
  | "core_missing_item"
  | "derived_missing_item";

type RedisReadyImageSamplePair = {
  member: string;
  value: string | null;
};

export type RedisReadyImageSampleResult = {
  status: RedisReadyImageSampleStatus;
  pairs: RedisReadyImageSamplePair[];
};

export type RedisReadyImageSampleBounds = {
  limit: number;
  recentSize: number;
  historySize: number;
  maximumLimit: number;
};

export type RedisReadyImageCoreSampleCommandClient =
  ReadyImageRedisCommandSource<"imageshowSampleReadyImageCoreIndex">;

export type RedisReadyImageDerivedSampleCommandClient =
  ReadyImageRedisCommandSource<"imageshowSampleReadyImageDerivedIndex">;

const readyImageSampleStatuses = new Map<number, RedisReadyImageSampleStatus>([
  [1, "ok"],
  [2, "empty"],
  [-1, "core_invalid"],
  [-2, "derived_invalid"],
  [-3, "revision_changed"],
  [-4, "token_changed"],
  [-5, "expired"],
  [-6, "core_missing_item"],
  [-7, "derived_missing_item"]
]);

function nonNegativeSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Ready-image sample contains invalid ${field}`);
  }
  return value;
}

function readyImageSampleBounds(bounds: RedisReadyImageSampleBounds) {
  const limit = nonNegativeSafeInteger(bounds.limit, "limit");
  const recentSize = nonNegativeSafeInteger(
    bounds.recentSize,
    "recent history size"
  );
  const historySize = nonNegativeSafeInteger(
    bounds.historySize,
    "history bound"
  );
  const maximumLimit = nonNegativeSafeInteger(
    bounds.maximumLimit,
    "maximum limit"
  );
  if (
    limit === 0
    || maximumLimit === 0
    || limit > maximumLimit
    || recentSize > historySize
  ) {
    throw new Error("Ready-image sample bounds are inconsistent");
  }
  return { limit, recentSize, historySize, maximumLimit };
}

function expectedReadyImageSampleCount(
  indexCount: number,
  bounds: ReturnType<typeof readyImageSampleBounds>
) {
  if (indexCount === 0) return 0;
  const requested = bounds.limit <= 1
    ? Math.max(8, Math.min(64, bounds.historySize + 1))
    : Math.min(indexCount, bounds.limit + bounds.recentSize);
  return Math.min(indexCount, requested);
}

function readyImageSampleReply(
  raw: unknown,
  expectedCount: number
): RedisReadyImageSampleResult {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error("Ready-image sample command returned invalid data");
  }
  const status = readyImageSampleStatuses.get(Number(raw[0]));
  const pairCount = Number(raw[1]);
  if (
    !status
    || !Number.isSafeInteger(pairCount)
    || pairCount < 0
    || pairCount > expectedCount
    || raw.length !== 2 + pairCount * 2
  ) {
    throw new Error("Ready-image sample command returned an invalid shape");
  }

  const pairs: RedisReadyImageSamplePair[] = [];
  for (let index = 0; index < pairCount; index += 1) {
    const member = raw[2 + index * 2];
    const rawValue = raw[3 + index * 2];
    if (
      typeof member !== "string"
      || !member
      || !(
        typeof rawValue === "string"
        || rawValue === null
        || rawValue === false
      )
    ) {
      throw new Error("Ready-image sample command returned an invalid pair");
    }
    pairs.push({
      member,
      value: typeof rawValue === "string" ? rawValue : null
    });
  }

  const missing = pairs.some(({ value }) => value === null);
  if (status === "ok") {
    if (pairCount !== expectedCount || expectedCount === 0 || missing) {
      throw new Error("Ready-image sample command returned inconsistent items");
    }
  } else if (status === "empty") {
    if (expectedCount !== 0 || pairCount !== 0) {
      throw new Error("Ready-image sample command returned inconsistent emptiness");
    }
  } else if (
    status === "core_missing_item"
    || status === "derived_missing_item"
  ) {
    if (pairCount !== expectedCount || expectedCount === 0 || !missing) {
      throw new Error("Ready-image sample command lost a missing-item position");
    }
  } else if (pairCount !== 0) {
    throw new Error("Ready-image sample command returned unexpected items");
  }
  return { status, pairs };
}

function readyImageSampleRevision(revision: string) {
  if (!/^\d+$/u.test(revision)) {
    throw new Error("Ready-image sample contains an invalid revision");
  }
  return revision;
}

export async function sampleReadyImageCoreIndexCommand(
  client: RedisReadyImageCoreSampleCommandClient,
  input: {
    keys: readonly [
      meta: string,
      integrity: string,
      index: string,
      items: string
    ];
    revision: string;
    count: number;
    bounds: RedisReadyImageSampleBounds;
  }
) {
  const count = nonNegativeSafeInteger(input.count, "core count");
  const bounds = readyImageSampleBounds(input.bounds);
  const commandClient = readyImageRedisCommandClient(
    client,
    "imageshowSampleReadyImageCoreIndex"
  );
  const raw = await commandClient.imageshowSampleReadyImageCoreIndex(
    ...input.keys,
    readyImageSampleRevision(input.revision),
    String(count),
    String(bounds.limit),
    String(bounds.recentSize),
    String(bounds.historySize),
    String(bounds.maximumLimit)
  );
  return readyImageSampleReply(
    raw,
    expectedReadyImageSampleCount(count, bounds)
  );
}

export async function sampleReadyImageDerivedIndexCommand(
  client: RedisReadyImageDerivedSampleCommandClient,
  input: {
    keys: readonly [
      meta: string,
      integrity: string,
      coreIndex: string,
      items: string,
      index: string,
      indexMeta: string
    ];
    kind: "attribute" | "filter";
    revision: string;
    coreCount: number;
    indexCount: number;
    instanceToken: string;
    maximumIndexMembers: number;
    bounds: RedisReadyImageSampleBounds;
  }
) {
  const coreCount = nonNegativeSafeInteger(input.coreCount, "core count");
  const indexCount = nonNegativeSafeInteger(input.indexCount, "index count");
  const maximumIndexMembers = nonNegativeSafeInteger(
    input.maximumIndexMembers,
    "maximum index members"
  );
  if (
    indexCount > coreCount
    || indexCount > maximumIndexMembers
    || !/^[0-9a-f]{32}$/u.test(input.instanceToken)
  ) {
    throw new Error("Ready-image derived sample input is inconsistent");
  }
  const bounds = readyImageSampleBounds(input.bounds);
  const commandClient = readyImageRedisCommandClient(
    client,
    "imageshowSampleReadyImageDerivedIndex"
  );
  const raw = await commandClient.imageshowSampleReadyImageDerivedIndex(
    ...input.keys,
    readyImageSampleRevision(input.revision),
    String(coreCount),
    String(indexCount),
    input.instanceToken,
    input.kind,
    String(bounds.limit),
    String(bounds.recentSize),
    String(bounds.historySize),
    String(bounds.maximumLimit),
    String(maximumIndexMembers)
  );
  return readyImageSampleReply(
    raw,
    expectedReadyImageSampleCount(indexCount, bounds)
  );
}
