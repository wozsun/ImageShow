import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ReadyImageRedisClient } from "../../../../packages/server/src/images/ready-cache/redis/client.ts";
type Redis = typeof import("../../../../packages/server/src/core/redis/client.ts").redis;
type ArrayCommandName = "imageshowReserveWindows" | "imageshowSampleReadyImageCoreIndex" | "imageshowSampleReadyImageDerivedIndex";
type BusinessCommands = Omit<ReadyImageRedisClient, ArrayCommandName> & Record<ArrayCommandName, (...args: Array<string | number>) => Promise<unknown[]>>;
type BusinessRedis = Redis & BusinessCommands;
type BusinessPipeline = ReturnType<Redis["pipeline"]> & Record<keyof BusinessCommands, (...args: Array<string | number>) => ReturnType<Redis["pipeline"]>>;

import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async () => {
const redisClient = await import("../../../../packages/server/src/core/redis/client.ts");
const redisWindowLimit = await import("../../../../packages/server/src/core/redis/window-limit.ts");
const readyCacheRedisClient = await import(
  "../../../../packages/server/src/images/ready-cache/redis/client.ts"
);
  redisWindowLimit.registerRedisWindowCommand(redisClient.redis);
  readyCacheRedisClient.registerReadyImageRedisCommands(redisClient.redis);
  const businessRedis = redisClient.redis as BusinessRedis;
  const businessPrefix = "imageshow:test:redis-business:" + randomUUID() + ":";
  const reserveKey = businessPrefix + "window:first";
  await redisClient.redis.call("SCRIPT", "FLUSH");
  assert.deepEqual(
    await businessRedis.imageshowReserveWindows(
      "1",
      reserveKey,
      "2",
      "60"
    ),
    [1, 1, 1, 60]
  );
  const repeatedReservation = await businessRedis.imageshowReserveWindows(
    "1",
    reserveKey,
    "2",
    "60"
  );
  assert.deepEqual(repeatedReservation.slice(0, 3), [1, 2, 1]);

  await redisClient.redis.call("SCRIPT", "FLUSH");
  const concurrentReservations = await Promise.all(Array.from(
    { length: 8 },
    (_, index) => businessRedis.imageshowReserveWindows(
      "1",
      businessPrefix + "window:concurrent:" + String(index),
      "1",
      "60"
    )
  ));
  assert.ok(concurrentReservations.every(
    (result) => JSON.stringify(result.slice(0, 3)) === "[1,1,1]"
  ));

  await redisClient.redis.call("SCRIPT", "FLUSH");
  const pipelineMarker = businessPrefix + "pipeline:marker";
  const pipelineWindow = businessPrefix + "pipeline:window";
  const pipeline = redisClient.redis.pipeline() as BusinessPipeline;
  pipeline.set(pipelineMarker, "pipeline-value");
  pipeline.imageshowReserveWindows("1", pipelineWindow, "1", "60");
  pipeline.get(pipelineMarker);
  const pipelineResults = await pipeline.exec();
  assert.equal(pipelineResults?.length, 3);
  assert.deepEqual(pipelineResults?.[0], [null, "OK"]);
  assert.deepEqual(pipelineResults?.[1], [null, [1, 1, 1, 60]]);
  assert.deepEqual(pipelineResults?.[2], [null, "pipeline-value"]);

  const multiMarker = businessPrefix + "multi:marker";
  const multiWindow = businessPrefix + "multi:window";
  const transaction = redisClient.redis.multi() as BusinessPipeline;
  transaction.set(multiMarker, "multi-value");
  transaction.imageshowReserveWindows("1", multiWindow, "1", "60");
  transaction.get(multiMarker);
  const transactionResults = await transaction.exec();
  assert.equal(transactionResults?.length, 3);
  assert.deepEqual(transactionResults?.[0], [null, "OK"]);
  assert.deepEqual(transactionResults?.[1], [null, [1, 1, 1, 60]]);
  assert.deepEqual(transactionResults?.[2], [null, "multi-value"]);

  const ttlSeconds = "300";
  const maximumResults = "50";
  const attributePrefix = businessPrefix + "derived:index:";
  const filterPrefix = businessPrefix + "derived:filter:";
  const statsPrefix = businessPrefix + "derived:stats:";
  const validationArguments = [
    attributePrefix,
    "axis:pc:dark,axis:pc:light,axis:mb:dark,axis:mb:light",
    "theme,tag,author",
    "63",
    filterPrefix,
    statsPrefix,
    "1000",
    "500",
    "4",
    "20",
    "16384"
  ];
  const registryKeys = (label: string) => [
    businessPrefix + label + ":registry:lru",
    businessPrefix + label + ":registry:counts",
    businessPrefix + label + ":registry:kinds",
    businessPrefix + label + ":registry:signatures"
  ];
  const installRegistryMember = async (
    keys: string[],
    member: string,
    count: string,
    kind: string,
    signature: string
  ) => {
    await redisClient.redis.zadd(keys[0], "1", member);
    await redisClient.redis.hset(keys[1], member, count);
    await redisClient.redis.hset(keys[2], member, kind);
    await redisClient.redis.hset(keys[3], member, signature);
  };

  const indexedRegistry = registryKeys("indexed");
  const indexedKey = attributePrefix + "theme:night";
  const indexedMetaKey = businessPrefix + "derived:index-meta:theme:night";
  const indexedToken = "a".repeat(32);
  const indexedNow = "2026-08-21T00:00:00.000Z";
  await installRegistryMember(
    indexedRegistry,
    indexedKey,
    "1",
    "attribute",
    ""
  );
  await redisClient.redis.zadd(indexedKey, "1", "image:one");
  await redisClient.redis.expire(indexedKey, 300);
  await redisClient.redis.hset(indexedMetaKey, {
    applied_revision: "42",
    count: "1",
    built_at: indexedNow,
    last_accessed: indexedNow,
    instance_token: indexedToken
  });
  await redisClient.redis.expire(indexedMetaKey, 300);
  assert.equal(await businessRedis.imageshowTouchReadyImageIndexedResult(
    indexedKey,
    indexedMetaKey,
    ...indexedRegistry,
    indexedKey,
    "1",
    "42",
    "2026-08-21T00:00:01.000Z",
    ttlSeconds,
    indexedToken,
    "5",
    "attribute",
    "",
    "2",
    maximumResults,
    "10",
    ...validationArguments
  ), 1);
  assert.equal(
    await redisClient.redis.hget(indexedMetaKey, "last_accessed"),
    "2026-08-21T00:00:01.000Z"
  );
  await redisClient.redis.hdel(indexedRegistry[3], indexedKey);
  assert.equal(await businessRedis.imageshowTouchReadyImageIndexedResult(
    indexedKey,
    indexedMetaKey,
    ...indexedRegistry,
    indexedKey,
    "1",
    "42",
    "2026-08-21T00:00:02.000Z",
    ttlSeconds,
    indexedToken,
    "5",
    "attribute",
    "",
    "3",
    maximumResults,
    "10",
    ...validationArguments
  ), -1);

  const statsRegistry = registryKeys("stats");
  const statsSignature = "b".repeat(64);
  const statsKey = statsPrefix + statsSignature;
  const serializedStats = "{\"total\":1}";
  await installRegistryMember(
    statsRegistry,
    statsKey,
    "0",
    "stats-result",
    statsSignature
  );
  await redisClient.redis.set(statsKey, serializedStats, "EX", 300);
  assert.equal(await businessRedis.imageshowTouchReadyImageStatsResult(
    statsKey,
    statsKey,
    ...statsRegistry,
    statsKey,
    serializedStats,
    ttlSeconds,
    statsSignature,
    "2",
    maximumResults,
    "10",
    ...validationArguments
  ), 1);
  assert.equal(await businessRedis.imageshowTouchReadyImageStatsResult(
    statsKey,
    statsKey,
    ...statsRegistry,
    statsKey,
    "{\"total\":2}",
    ttlSeconds,
    statsSignature,
    "3",
    maximumResults,
    "10",
    ...validationArguments
  ), 0);

  const filterSourceA = businessPrefix + "filter:source:a";
  const filterSourceB = businessPrefix + "filter:source:b";
  const filterDestination = businessPrefix + "filter:destination";
  await redisClient.redis.zadd(filterSourceA, "1", "one", "2", "shared");
  await redisClient.redis.zadd(filterSourceB, "2", "shared", "3", "three");
  assert.deepEqual(await businessRedis.imageshowStoreReadyImageFilterSet(
    "3",
    filterSourceA,
    filterSourceB,
    filterDestination,
    "2",
    "2",
    "ZUNIONSTORE",
    "3",
    "60"
  ), [1, 3, 1, 3]);
  assert.deepEqual(await businessRedis.imageshowStoreReadyImageFilterSet(
    "3",
    filterSourceA,
    filterSourceB,
    filterDestination,
    "99",
    "2",
    "ZUNIONSTORE",
    "3",
    "60"
  ), [0, 1, 2]);

  const publishedKey = businessPrefix + "attribute:published";
  const publishedMetaKey = businessPrefix + "attribute:meta";
  const publishedTemporaryKey = businessPrefix + "attribute:temporary";
  const publishedToken = "c".repeat(32);
  await redisClient.redis.zadd(
    publishedTemporaryKey,
    "1",
    "one",
    "2",
    "two"
  );
  assert.equal(
    await businessRedis.imageshowPublishReadyImageAttributeIndex(
      publishedKey,
      publishedMetaKey,
      publishedTemporaryKey,
      "2",
      "42",
      indexedNow,
      indexedNow,
      publishedToken,
      ttlSeconds
    ),
    1
  );
  assert.equal(await redisClient.redis.zcard(publishedKey), 2);
  assert.equal(
    await redisClient.redis.hget(publishedMetaKey, "applied_revision"),
    "42"
  );
  assert.equal(
    await businessRedis.imageshowPublishReadyImageAttributeIndex(
      publishedKey,
      publishedMetaKey,
      businessPrefix + "attribute:missing",
      "1",
      "43",
      indexedNow,
      indexedNow,
      publishedToken,
      ttlSeconds
    ),
    0
  );
  assert.equal(
    await redisClient.redis.hget(publishedMetaKey, "applied_revision"),
    "42"
  );

  const sampleMetaKey = businessPrefix + "sample:core:meta";
  const sampleIntegrityKey = businessPrefix + "sample:core:integrity";
  const sampleCoreIndexKey = businessPrefix + "sample:core:index";
  const sampleItemsKey = businessPrefix + "sample:core:items";
  const sampleMembers = ["image:first", "image:second", "image:third"];
  const sampleValues = new Map(sampleMembers.map((member, index) => [
    member,
    JSON.stringify({ id: member.slice("image:".length), index })
  ]));
  await redisClient.redis.hset(sampleMetaKey, {
    state: "ready",
    applied_revision: "42",
    item_count: "3"
  });
  await redisClient.redis.hset(sampleIntegrityKey, {
    [sampleCoreIndexKey]: "3",
    [sampleItemsKey]: "3"
  });
  await redisClient.redis.zadd(
    sampleCoreIndexKey,
    ...sampleMembers.flatMap((member, index) => [String(index + 1), member])
  );
  await redisClient.redis.hset(
    sampleItemsKey,
    Object.fromEntries(sampleValues)
  );
  const coreSampleArguments = [
    sampleMetaKey,
    sampleIntegrityKey,
    sampleCoreIndexKey,
    sampleItemsKey,
    "42",
    "3",
    "2",
    "1",
    "30",
    "200"
  ];
  const coreSample = await businessRedis.imageshowSampleReadyImageCoreIndex(
    ...coreSampleArguments
  );
  assert.deepEqual(coreSample.slice(0, 2), [1, 3]);
  assert.equal(coreSample.length, 8);
  for (let index = 0; index < 3; index += 1) {
    const member = String(coreSample[2 + index * 2]);
    assert.equal(coreSample[3 + index * 2], sampleValues.get(member));
  }

  const emptyMetaKey = businessPrefix + "sample:empty:meta";
  const emptyIntegrityKey = businessPrefix + "sample:empty:integrity";
  const emptyIndexKey = businessPrefix + "sample:empty:index";
  const emptyItemsKey = businessPrefix + "sample:empty:items";
  await redisClient.redis.hset(emptyMetaKey, {
    state: "ready",
    applied_revision: "42",
    item_count: "0"
  });
  await redisClient.redis.hset(emptyIntegrityKey, {
    [emptyIndexKey]: "0",
    [emptyItemsKey]: "0"
  });
  assert.deepEqual(
    await businessRedis.imageshowSampleReadyImageCoreIndex(
      emptyMetaKey,
      emptyIntegrityKey,
      emptyIndexKey,
      emptyItemsKey,
      "42",
      "0",
      "1",
      "0",
      "30",
      "200"
    ),
    [2, 0]
  );

  const sampleAttributeIndexKey = businessPrefix + "sample:attribute:index";
  const sampleAttributeMetaKey = businessPrefix + "sample:attribute:meta";
  const sampleAttributeToken = "d".repeat(32);
  await redisClient.redis.zadd(
    sampleAttributeIndexKey,
    "1",
    sampleMembers[0],
    "2",
    sampleMembers[1]
  );
  await redisClient.redis.expire(sampleAttributeIndexKey, 300);
  await redisClient.redis.hset(sampleAttributeMetaKey, {
    applied_revision: "42",
    count: "2",
    built_at: indexedNow,
    last_accessed: indexedNow,
    instance_token: sampleAttributeToken
  });
  await redisClient.redis.expire(sampleAttributeMetaKey, 300);
  const derivedSampleArguments = [
    sampleMetaKey,
    sampleIntegrityKey,
    sampleCoreIndexKey,
    sampleItemsKey,
    sampleAttributeIndexKey,
    sampleAttributeMetaKey,
    "42",
    "3",
    "2",
    sampleAttributeToken,
    "attribute",
    "1",
    "0",
    "30",
    "200",
    "250000"
  ];
  const attributeSample = await businessRedis.imageshowSampleReadyImageDerivedIndex(...derivedSampleArguments);
  assert.deepEqual(attributeSample.slice(0, 2), [1, 2]);
  assert.equal(attributeSample.length, 6);

  const sampleFilterIndexKey = businessPrefix + "sample:filter:index";
  const sampleFilterMetaKey = businessPrefix + "sample:filter:meta";
  const sampleFilterToken = "e".repeat(32);
  await redisClient.redis.zadd(sampleFilterIndexKey, "1", sampleMembers[2]);
  await redisClient.redis.expire(sampleFilterIndexKey, 300);
  await redisClient.redis.hset(sampleFilterMetaKey, {
    applied_revision: "42",
    count: "1",
    built_at: indexedNow,
    instance_token: sampleFilterToken
  });
  await redisClient.redis.expire(sampleFilterMetaKey, 300);
  assert.deepEqual((await businessRedis.imageshowSampleReadyImageDerivedIndex(
    sampleMetaKey,
    sampleIntegrityKey,
    sampleCoreIndexKey,
    sampleItemsKey,
    sampleFilterIndexKey,
    sampleFilterMetaKey,
    "42",
    "3",
    "1",
    sampleFilterToken,
    "filter",
    "1",
    "0",
    "30",
    "200",
    "250000"
  )).slice(0, 2), [1, 1]);

  await redisClient.redis.hset(sampleMetaKey, "applied_revision", "43");
  assert.deepEqual(
    await businessRedis.imageshowSampleReadyImageCoreIndex(
      ...coreSampleArguments
    ),
    [-3, 0]
  );
  await redisClient.redis.hset(sampleMetaKey, "applied_revision", "42");
  assert.deepEqual((await businessRedis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments.slice(0, 9),
    "f".repeat(32),
    ...derivedSampleArguments.slice(10)
  )).slice(0, 2), [-4, 0]);
  await redisClient.redis.persist(sampleAttributeMetaKey);
  assert.deepEqual((await businessRedis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-5, 0]);
  await redisClient.redis.expire(sampleAttributeMetaKey, 300);
  await redisClient.redis.hset(sampleAttributeMetaKey, "built_at", "invalid");
  assert.deepEqual((await businessRedis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-2, 0]);
  await redisClient.redis.hset(
    sampleAttributeMetaKey,
    "built_at",
    "2026-13-40T25:61:61.999Z"
  );
  assert.deepEqual((await businessRedis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-2, 0]);
  await redisClient.redis.hset(sampleAttributeMetaKey, "built_at", indexedNow);
  await redisClient.redis.del(sampleAttributeIndexKey);
  assert.deepEqual((await businessRedis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-5, 0]);
  await redisClient.redis.zadd(
    sampleAttributeIndexKey,
    "1",
    sampleMembers[0],
    "2",
    sampleMembers[1]
  );
  await redisClient.redis.expire(sampleAttributeIndexKey, 300);
  await redisClient.redis.zrem(sampleAttributeIndexKey, sampleMembers[0]);
  assert.deepEqual((await businessRedis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-2, 0]);
  await redisClient.redis.zadd(sampleAttributeIndexKey, "1", sampleMembers[0]);
  await redisClient.redis.expire(sampleAttributeIndexKey, 300);

  await redisClient.redis.hset(
    sampleIntegrityKey,
    sampleCoreIndexKey,
    "2"
  );
  assert.deepEqual(
    await businessRedis.imageshowSampleReadyImageCoreIndex(
      ...coreSampleArguments
    ),
    [-1, 0]
  );
  await redisClient.redis.hset(
    sampleIntegrityKey,
    sampleCoreIndexKey,
    "3"
  );

  const orphanIndexKey = businessPrefix + "sample:orphan:index";
  const orphanMetaKey = businessPrefix + "sample:orphan:meta";
  const sampleOrphanToken = "f".repeat(32);
  await redisClient.redis.zadd(orphanIndexKey, "1", "image:orphan");
  await redisClient.redis.expire(orphanIndexKey, 300);
  await redisClient.redis.hset(orphanMetaKey, {
    applied_revision: "42",
    count: "1",
    built_at: indexedNow,
    instance_token: sampleOrphanToken
  });
  await redisClient.redis.expire(orphanMetaKey, 300);
  assert.deepEqual(
    await businessRedis.imageshowSampleReadyImageDerivedIndex(
      sampleMetaKey,
      sampleIntegrityKey,
      sampleCoreIndexKey,
      sampleItemsKey,
      orphanIndexKey,
      orphanMetaKey,
      "42",
      "3",
      "1",
      sampleOrphanToken,
      "filter",
      "1",
      "0",
      "30",
      "200",
      "250000"
    ),
    [-7, 1, "image:orphan", null]
  );

  await redisClient.redis.hdel(sampleItemsKey, sampleMembers[0]);
  await redisClient.redis.hset(sampleItemsKey, "image:extra", "{\"id\":\"extra\"}");
  const missingCoreSample = await businessRedis.imageshowSampleReadyImageCoreIndex(...coreSampleArguments);
  assert.equal(missingCoreSample[0], -6);
  assert.equal(missingCoreSample[1], 3);
  assert.ok(missingCoreSample.includes(null));
  await redisClient.redis.hdel(sampleItemsKey, "image:extra");
  await redisClient.redis.hset(
    sampleItemsKey,
    sampleMembers[0],
    sampleValues.get(sampleMembers[0])!
  );

  await redisClient.redis.call("SCRIPT", "FLUSH");
  await businessRedis.imageshowSampleReadyImageCoreIndex(
    ...coreSampleArguments
  );
  await businessRedis.imageshowSampleReadyImageCoreIndex(
    ...coreSampleArguments
  );

  await redisClient.redis.call("SCRIPT", "FLUSH");
  const concurrentSamples = await Promise.all(Array.from(
    { length: 8 },
    () => businessRedis.imageshowSampleReadyImageCoreIndex(
      ...coreSampleArguments
    )
  ));
  assert.ok(concurrentSamples.every((sample) => (
    sample[0] === 1 && sample[1] === 3
  )));

  const samplePipelineMarker = businessPrefix + "sample:pipeline:marker";
  const samplePipeline = redisClient.redis.pipeline() as BusinessPipeline;
  samplePipeline.set(samplePipelineMarker, "sample-pipeline");
  samplePipeline.imageshowSampleReadyImageCoreIndex(...coreSampleArguments);
  samplePipeline.get(samplePipelineMarker);
  const samplePipelineResults = await samplePipeline.exec();
  assert.equal(samplePipelineResults?.length, 3);
  assert.equal(samplePipelineResults?.[1]?.[0], null);
  assert.deepEqual(
    (samplePipelineResults?.[1]?.[1] as unknown[]).slice(0, 2),
    [1, 3]
  );

  const sampleMultiMarker = businessPrefix + "sample:multi:marker";
  await businessRedis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  );
  const sampleMulti = redisClient.redis.multi() as BusinessPipeline;
  sampleMulti.set(sampleMultiMarker, "sample-multi");
  sampleMulti.imageshowSampleReadyImageDerivedIndex(...derivedSampleArguments);
  sampleMulti.get(sampleMultiMarker);
  const sampleMultiResults = await sampleMulti.exec();
  assert.equal(sampleMultiResults?.length, 3);
  assert.equal(sampleMultiResults?.[1]?.[0], null);
  assert.deepEqual(
    (sampleMultiResults?.[1]?.[1] as unknown[]).slice(0, 2),
    [1, 2]
  );

  const firstSampleConnection = redisClient.redis.duplicate({
    lazyConnect: true,
    retryStrategy: () => 1
  }) as BusinessRedis;
  try {
    await firstSampleConnection.connect();
    await firstSampleConnection.ping();
    assert.deepEqual((await firstSampleConnection
      .imageshowSampleReadyImageCoreIndex(...coreSampleArguments)).slice(0, 2), [1, 3]);
  } finally {
    firstSampleConnection.disconnect();
  }
  const replacementSampleConnection = redisClient.redis.duplicate({
    lazyConnect: true
  }) as BusinessRedis;
  try {
    await replacementSampleConnection.connect();
    assert.deepEqual((await replacementSampleConnection
      .imageshowSampleReadyImageCoreIndex(...coreSampleArguments)).slice(0, 2), [1, 3]);
  } finally {
    replacementSampleConnection.disconnect();
  }

  let businessCursor = "0";
  do {
    const [nextCursor, keys] = await redisClient.redis.scan(
      businessCursor,
      "MATCH",
      businessPrefix + "*",
      "COUNT",
      "100"
    );
    businessCursor = nextCursor;
    if (keys.length > 0) await redisClient.redis.unlink(...keys);
  } while (businessCursor !== "0");
});
