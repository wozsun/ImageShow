import type { Redis, RedisOptions } from "ioredis";
import {
  publishReadyImageAttributeIndexScript,
  reserveRedisWindowsScript,
  storeReadyImageFilterSetScript,
  touchReadyImageIndexedResultScript,
  touchReadyImageStatsResultScript
} from "./redis-business-scripts.ts";

export const redisBusinessScripts = Object.freeze({
  imageshowReserveWindows: {
    lua: reserveRedisWindowsScript,
    readOnly: false
  },
  imageshowTouchReadyImageIndexedResult: {
    lua: touchReadyImageIndexedResultScript,
    numberOfKeys: 6,
    readOnly: false
  },
  imageshowTouchReadyImageStatsResult: {
    lua: touchReadyImageStatsResultScript,
    numberOfKeys: 6,
    readOnly: false
  },
  imageshowStoreReadyImageFilterSet: {
    lua: storeReadyImageFilterSetScript,
    readOnly: false
  },
  imageshowPublishReadyImageAttributeIndex: {
    lua: publishReadyImageAttributeIndexScript,
    numberOfKeys: 3,
    readOnly: false
  }
}) satisfies NonNullable<RedisOptions["scripts"]>;

export type RedisWindow = {
  key: string;
  capacity: number;
  windowSeconds: number;
};

export type RedisWindowReservation = {
  attempted: boolean;
  allowed: boolean;
  value: number;
  retryAfterSeconds: number;
};

export type RedisWindowCommandClient = {
  imageshowReserveWindows(
    ...arguments_: Parameters<Redis["imageshowReserveWindows"]>
  ): Promise<unknown>;
};

export type RedisIndexedTouchCommandClient = {
  imageshowTouchReadyImageIndexedResult(
    ...arguments_: Parameters<
      Redis["imageshowTouchReadyImageIndexedResult"]
    >
  ): Promise<unknown>;
};

export type RedisStatsTouchCommandClient = {
  imageshowTouchReadyImageStatsResult(
    ...arguments_: Parameters<Redis["imageshowTouchReadyImageStatsResult"]>
  ): Promise<unknown>;
};

export type RedisFilterSetCommandClient = {
  imageshowStoreReadyImageFilterSet(
    ...arguments_: Parameters<Redis["imageshowStoreReadyImageFilterSet"]>
  ): Promise<unknown>;
  unlink(...keys: string[]): Promise<number>;
};

export type RedisAttributePublishCommandClient = {
  imageshowPublishReadyImageAttributeIndex(
    ...arguments_: Parameters<
      Redis["imageshowPublishReadyImageAttributeIndex"]
    >
  ): Promise<unknown>;
};

function integer(value: unknown, context: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Redis window script returned invalid ${context}`);
  }
  return parsed;
}

export async function reserveRedisWindowsCommand(
  client: RedisWindowCommandClient,
  windows: readonly RedisWindow[]
): Promise<RedisWindowReservation[]> {
  const raw = await client.imageshowReserveWindows(
    String(windows.length),
    ...windows.map((window) => window.key),
    ...windows.flatMap((window) => [
      String(window.capacity),
      String(window.windowSeconds)
    ])
  );
  if (!Array.isArray(raw) || raw.length !== windows.length * 4) {
    throw new Error("Redis window script returned an invalid result count");
  }

  return windows.map((window, index) => {
    const offset = index * 4;
    const state = integer(raw[offset], "reservation state");
    const current = integer(raw[offset + 1], "reservation value");
    const increment = integer(raw[offset + 2], "reservation increment");
    const ttl = integer(raw[offset + 3], "reservation TTL");
    if (
      ![-1, 0, 1].includes(state)
      || current < 0
      || ![0, 1].includes(increment)
      || (state === 1) !== (increment === 1)
    ) {
      throw new Error("Redis window script returned inconsistent state");
    }
    return {
      attempted: state !== -1,
      allowed: state === 1,
      value: current,
      retryAfterSeconds: Math.max(1, ttl >= 0 ? ttl : window.windowSeconds)
    };
  });
}

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
  const raw = await client.imageshowTouchReadyImageIndexedResult(
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
  const raw = await client.imageshowTouchReadyImageStatsResult(
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
  const raw = await client.imageshowStoreReadyImageFilterSet(
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
  const raw = await client.imageshowPublishReadyImageAttributeIndex(
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
