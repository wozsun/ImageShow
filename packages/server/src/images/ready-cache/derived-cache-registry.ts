import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  assertReadyImageDerivedResult,
  derivedRegistryKeys,
  describeReadyImageDerivedResult,
  nextDerivedAccessScore,
  nonNegativeInteger,
  readyImageDerivedMembershipLimit,
  type DerivedResultDescriptor
} from "./derived-cache-common.ts";
import {
  forgetReadyImageDerivedOccupancy,
  rememberReadyImageDerivedOccupancy,
  setReadyImageDerivedRegistryMemory
} from "./derived-cache-occupancy.ts";
import {
  READY_IMAGE_DERIVED_CACHE_POLICY,
  type ReadyImageDerivedResultKind
} from "./derived-cache-policy.ts";
import {
  READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY,
  READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
  READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY,
  assertReadyImageDerivedCacheKey
} from "./keys.ts";
import { REDIS_BATCH_MAX_COMMANDS } from "./redis-batch.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";

const MAX_EVICTION_COMMANDS_PER_RESULT = 6;
const EVICTION_BATCH_SIZE = Math.floor(
  REDIS_BATCH_MAX_COMMANDS / MAX_EVICTION_COMMANDS_PER_RESULT
);
const MAX_REGISTRY_ENTRIES_DURING_REGISTRATION =
  READY_IMAGE_DERIVED_CACHE_POLICY.maxResults + 1;

type DerivedRegistryEntry = DerivedResultDescriptor & {
  count: number;
  bytes: number | null;
};

function observedMemoryBytes(raw: unknown) {
  if (String(raw ?? "") === "-1") return null;
  return nonNegativeInteger(raw) ?? undefined;
}

function observeDerivedMemoryKeys(
  keys: string[],
  errorCode: string,
  allMissingIsEmpty = false
) {
  return (async () => {
    try {
      const pipeline = redis.pipeline();
      for (const key of keys) pipeline.call("MEMORY", "USAGE", key);
      const results = await execRedisPipeline(pipeline);
      if (
        allMissingIsEmpty
        && results.every((result) => result?.[1] === null)
      ) {
        return 0;
      }
      let total = 0;
      for (const result of results) {
        const bytes = nonNegativeInteger(result?.[1]);
        if (bytes === null || !Number.isSafeInteger(total + bytes)) {
          throw new Error("Ready-image derived memory observation is invalid");
        }
        total += bytes;
      }
      return total;
    } catch (error) {
      recordReadyImageCacheError("derived", errorCode, error);
      return null;
    }
  })();
}

function observeDerivedResultMemory(
  descriptor: DerivedResultDescriptor,
  count: number
) {
  return observeDerivedMemoryKeys(
    [
      ...(descriptor.kind === "stats-result" || count > 0
        ? [descriptor.key]
        : []),
      ...(descriptor.metaKey ? [descriptor.metaKey] : [])
    ],
    "derived_memory_observation_failed"
  );
}

function observeDerivedRegistryMemory() {
  return observeDerivedMemoryKeys(
    derivedRegistryKeys,
    "derived_registry_memory_observation_failed",
    true
  );
}

export async function evictReadyImageDerivedResults(keys: Iterable<string>) {
  const uniqueKeys = [...new Set(keys)];
  let modified = false;
  for (
    let offset = 0;
    offset < uniqueKeys.length;
    offset += EVICTION_BATCH_SIZE
  ) {
    const batch = uniqueKeys.slice(offset, offset + EVICTION_BATCH_SIZE);
    const transaction = redis.multi();
    for (const key of batch) {
      assertReadyImageDerivedCacheKey(key);
      const descriptor = describeReadyImageDerivedResult(key);
      if (descriptor) {
        transaction.unlink(key);
        if (descriptor.metaKey) transaction.unlink(descriptor.metaKey);
      }
      transaction.zrem(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY, key);
      transaction.hdel(READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY, key);
      transaction.hdel(READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY, key);
      transaction.hdel(READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY, key);
      transaction.hdel(READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY, key);
    }
    const results = await execRedisPipeline(transaction);
    if (results.some((result) => Number(result?.[1] ?? 0) > 0)) {
      modified = true;
    }
    forgetReadyImageDerivedOccupancy(batch);
  }
  if (uniqueKeys.length) {
    setReadyImageDerivedRegistryMemory(await observeDerivedRegistryMemory());
  }
  return modified;
}

async function assertDerivedRegistryStructure() {
  const typePipeline = redis.pipeline();
  for (const key of derivedRegistryKeys) typePipeline.type(key);
  const typeResults = await execRedisPipeline(typePipeline);
  const types = typeResults.map((result) => String(result?.[1] ?? ""));
  if (types.every((type) => type === "none")) return;
  if (
    types[0] !== "zset"
    || types.slice(1).some((type) => type !== "hash")
  ) {
    throw new Error("Ready-image derived registry has inconsistent key types");
  }

  const sizePipeline = redis.pipeline();
  sizePipeline.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY);
  sizePipeline.hlen(READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY);
  sizePipeline.hlen(READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY);
  sizePipeline.hlen(READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY);
  sizePipeline.hlen(READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY);
  const sizeResults = await execRedisPipeline(sizePipeline);
  const sizes = sizeResults.map((result) => nonNegativeInteger(result?.[1]));
  if (
    sizes.some((size) => size === null)
    || sizes.some((size) => size !== sizes[0])
  ) {
    throw new Error("Ready-image derived registry has inconsistent field sets");
  }
  if ((sizes[0] ?? 0) > MAX_REGISTRY_ENTRIES_DURING_REGISTRATION) {
    throw new Error("Ready-image derived registry exceeds the result limit");
  }

  const membersPipeline = redis.pipeline();
  membersPipeline.zrange(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY, "0", "-1");
  membersPipeline.hkeys(READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY);
  membersPipeline.hkeys(READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY);
  membersPipeline.hkeys(READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY);
  membersPipeline.hkeys(READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY);
  const memberResults = await execRedisPipeline(membersPipeline);
  const memberSets = memberResults.map((result) => (
    [...(result?.[1] as string[] ?? [])].sort()
  ));
  const expected = JSON.stringify(memberSets[0]);
  if (memberSets.slice(1).some((members) => (
    JSON.stringify(members) !== expected
  ))) {
    throw new Error("Ready-image derived registry has inconsistent field sets");
  }
}

async function trimRegistryEntryCount() {
  for (;;) {
    const count = await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY);
    const overflow = count - READY_IMAGE_DERIVED_CACHE_POLICY.maxResults;
    if (overflow <= 0) return;
    const victims = await redis.zrange(
      READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
      "0",
      String(Math.min(overflow, EVICTION_BATCH_SIZE) - 1)
    );
    if (!victims.length) return;
    await evictReadyImageDerivedResults(victims);
  }
}

async function readDerivedRegistry() {
  await assertDerivedRegistryStructure();
  await trimRegistryEntryCount();
  const keys = await redis.zrange(
    READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
    "0",
    "-1"
  );
  if (!keys.length) return { valid: [], invalid: [] };

  const descriptors = keys.map(describeReadyImageDerivedResult);
  const pipeline = redis.pipeline();
  pipeline.hmget(READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY, ...keys);
  pipeline.hmget(READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY, ...keys);
  pipeline.hmget(READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY, ...keys);
  pipeline.hmget(READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY, ...keys);
  for (const [index, key] of keys.entries()) {
    pipeline.exists(key);
    pipeline.ttl(key);
    if (descriptors[index] && descriptors[index]?.kind !== "stats-result") {
      pipeline.zcard(key);
    }
    const metaKey = descriptors[index]?.metaKey;
    if (metaKey) {
      pipeline.exists(metaKey);
      pipeline.ttl(metaKey);
    }
  }
  const results = await execRedisPipeline(pipeline);
  const counts = results[0]?.[1] as Array<string | null> ?? [];
  const bytes = results[1]?.[1] as Array<string | null> ?? [];
  const kinds = results[2]?.[1] as Array<string | null> ?? [];
  const signatures = results[3]?.[1] as Array<string | null> ?? [];
  const valid: DerivedRegistryEntry[] = [];
  const invalid: string[] = [];
  let resultIndex = 4;

  keys.forEach((key, index) => {
    const descriptor = descriptors[index];
    const primaryExists = Number(results[resultIndex]?.[1] ?? 0) === 1;
    resultIndex += 1;
    const primaryTtl = Number(results[resultIndex]?.[1] ?? -2);
    resultIndex += 1;
    let cardinality: number | null = null;
    if (descriptor && descriptor.kind !== "stats-result") {
      cardinality = nonNegativeInteger(results[resultIndex]?.[1]);
      resultIndex += 1;
    }
    let metaExists = false;
    let metaTtl = -2;
    if (descriptor?.metaKey) {
      metaExists = Number(results[resultIndex]?.[1] ?? 0) === 1;
      resultIndex += 1;
      metaTtl = Number(results[resultIndex]?.[1] ?? -2);
      resultIndex += 1;
    }
    const count = nonNegativeInteger(counts[index]);
    const memoryBytes = observedMemoryBytes(bytes[index]);
    const signature = signatures[index] || null;
    const validPrimary = descriptor?.kind === "stats-result"
      ? primaryExists && primaryTtl > 0
      : count === 0 || (primaryExists && primaryTtl > 0);
    if (
      !descriptor
      || kinds[index] !== descriptor.kind
      || signature !== descriptor.signature
      || count === null
      || memoryBytes === undefined
      || (descriptor.kind === "stats-result" && count !== 0)
      || (descriptor.kind !== "stats-result" && cardinality !== count)
      || !validPrimary
      || (descriptor.metaKey && (!metaExists || metaTtl <= 0))
    ) {
      invalid.push(key);
      return;
    }
    valid.push({ ...descriptor, count, bytes: memoryBytes });
  });
  return { valid, invalid };
}

export async function registerReadyImageDerivedResultUnchecked(options: {
  key: string;
  kind: ReadyImageDerivedResultKind;
  count: number;
  itemCount: number;
}) {
  const { key, kind, count, itemCount } = options;
  const descriptor = assertReadyImageDerivedResult(key, kind);
  if (
    nonNegativeInteger(count) === null
    || nonNegativeInteger(itemCount) === null
    || (kind === "stats-result" && count !== 0)
  ) {
    throw new Error("Ready-image derived result has an invalid cardinality");
  }
  if (
    kind !== "stats-result"
    && (
      count > itemCount
      || count > READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers
    )
  ) {
    await evictReadyImageDerivedResults([key]);
    return false;
  }

  const memoryBytes = await observeDerivedResultMemory(descriptor, count);
  await assertDerivedRegistryStructure();
  await trimRegistryEntryCount();

  const transaction = redis.multi();
  transaction.zadd(
    READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
    nextDerivedAccessScore(),
    key
  );
  transaction.hset(READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY, key, String(count));
  transaction.hset(
    READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY,
    key,
    String(memoryBytes ?? -1)
  );
  transaction.hset(READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY, key, kind);
  transaction.hset(
    READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY,
    key,
    descriptor.signature ?? ""
  );
  for (const registryKey of derivedRegistryKeys) {
    transaction.expire(
      registryKey,
      READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds
    );
  }
  await execRedisPipeline(transaction);
  rememberReadyImageDerivedOccupancy({
    key,
    kind,
    count,
    bytes: memoryBytes
  });

  const registry = await readDerivedRegistry();
  const victims = new Set(registry.invalid);
  let retained = registry.valid.filter((entry) => !victims.has(entry.key));
  let memberships = retained.reduce((sum, entry) => (
    entry.kind === "stats-result" ? sum : sum + entry.count
  ), 0);
  if (!Number.isSafeInteger(memberships)) {
    throw new Error("Ready-image derived memberships are outside the safe range");
  }
  const remove = (entry: DerivedRegistryEntry) => {
    if (victims.has(entry.key)) return;
    victims.add(entry.key);
    if (entry.kind !== "stats-result") memberships -= entry.count;
  };

  for (const entry of retained) {
    if (
      entry.kind !== "stats-result"
      && (
        entry.count > itemCount
        || entry.count > READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers
      )
    ) {
      remove(entry);
    }
  }
  retained = retained.filter((entry) => !victims.has(entry.key));

  for (;;) {
    const signatures = new Set(retained.flatMap((entry) => (
      entry.signature ? [entry.signature] : []
    )));
    if (signatures.size <= READY_IMAGE_DERIVED_CACHE_POLICY.maxActiveSignatures) {
      break;
    }
    const oldestSignature = retained.find((entry) => entry.signature)?.signature;
    if (!oldestSignature) break;
    for (const entry of retained) {
      if (entry.signature === oldestSignature) remove(entry);
    }
    retained = retained.filter((entry) => !victims.has(entry.key));
  }

  const membershipLimit = readyImageDerivedMembershipLimit(itemCount);
  while (
    retained.length > READY_IMAGE_DERIVED_CACHE_POLICY.maxResults
    || memberships > membershipLimit
  ) {
    const victim = retained.shift();
    if (!victim) break;
    remove(victim);
  }
  await evictReadyImageDerivedResults(victims);
  setReadyImageDerivedRegistryMemory(await observeDerivedRegistryMemory());
  return !victims.has(key);
}
