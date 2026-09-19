import assert from "node:assert/strict";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async ({ redisClient: { redis } }) => {
  const { READY_IMAGE_DERIVED_CACHE_POLICY: policy } = await import("../../../../packages/server/src/images/ready-cache/derived/policy.ts");
  const { registerReadyImageDerivedResultUnchecked: register } = await import("../../../../packages/server/src/images/ready-cache/derived/registry.ts");
  const { storeReadyImageStatsResult, touchReadyImageStatsResult, clearReadyImageDisposableCaches } = await import("../../../../packages/server/src/images/ready-cache/derived/lifecycle.ts");
  const { READY_IMAGE_STATS_RESULT_KEY_PREFIX, READY_IMAGE_FILTER_KEY_PREFIX, READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
    readyImageFilterMetaKeyForFilterKey, readyImageAttributeIndexKey, readyImageAttributeIndexMetaKey } = await import("../../../../packages/server/src/images/ready-cache/keys.ts");
  const signature = (i: number) => i.toString(16).padStart(64, "0");
  const statsKey = (i: number) => READY_IMAGE_STATS_RESULT_KEY_PREFIX + signature(i);
  const firstStats = statsKey(0);
  const oneMiB = JSON.stringify({ value: "界" + "a".repeat(policy.maxStatsResultBytes - Buffer.byteLength(JSON.stringify({ value: "界" }))) });
  assert.equal(Buffer.byteLength(oneMiB), policy.maxStatsResultBytes);
  assert.equal(await storeReadyImageStatsResult(firstStats, oneMiB, 1000), true);
  assert.equal(await redis.get(firstStats), oneMiB);
  await redis.expire(firstStats, 30);
  assert.equal(await touchReadyImageStatsResult(firstStats, oneMiB, 1000), true);
  assert.ok(await redis.ttl(firstStats) > policy.ttlSeconds - 5);
  assert.equal(await storeReadyImageStatsResult(firstStats, oneMiB + " ", 1000), false);
  assert.equal(await redis.exists(firstStats), 0, "oversized replacement removes the prior result");

  const firstFilter = READY_IMAGE_FILTER_KEY_PREFIX + signature(0);
  const firstMeta = readyImageFilterMetaKeyForFilterKey(firstFilter);
  await redis.hset(firstMeta, { count: "0" });
  await redis.expire(firstMeta, policy.ttlSeconds);
  assert.equal(await register({ key: firstFilter, kind: "filter", count: 0, itemCount: 1000 }), true);
  for (let i = 0; i <= policy.maxActiveSignatures; i++) {
    assert.equal(await storeReadyImageStatsResult(statsKey(i), "{}", 1000), true);
  }
  assert.equal(await redis.exists(firstStats, firstFilter, firstMeta), 0, "signature eviction retires its stats and filter metadata together");
  assert.equal(await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY), policy.maxActiveSignatures);
  assert.equal(await redis.exists(statsKey(1), statsKey(policy.maxActiveSignatures)), 2);
  await clearReadyImageDisposableCaches();

  const itemCount = 1000;
  const members = Array.from({ length: itemCount }, (_, i) => [String(i), `synthetic-member-${i}`]).flat();
  const keys: string[] = [];
  for (let i = 0; i <= policy.totalMemberMultiplier; i++) {
    const key = readyImageAttributeIndexKey({ kind: "tag", value: `budget-${i}` });
    const meta = readyImageAttributeIndexMetaKey(key);
    keys.push(key);
    await redis.zadd(key, ...members);
    await redis.expire(key, policy.ttlSeconds);
    await redis.hset(meta, { count: String(itemCount) });
    await redis.expire(meta, policy.ttlSeconds);
    assert.equal(await register({ key, kind: "attribute", count: itemCount, itemCount }), true);
  }
  assert.equal(await redis.exists(keys[0]!, readyImageAttributeIndexMetaKey(keys[0]!)), 0);
  assert.equal(await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY), policy.totalMemberMultiplier);
  assert.equal(await redis.zcard(keys.at(-1)!), itemCount);
  await clearReadyImageDisposableCaches();
});
