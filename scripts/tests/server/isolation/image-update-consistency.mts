import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const imageUpdate = await import("../../../../packages/server/src/images/image-update.ts");
const redisClient = await import("../../../../packages/server/src/core/redis/client.ts");
const readyCacheCoordinator = await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
const readyCacheMeta = await import("../../../../packages/server/src/images/ready-cache/meta.ts");
const readyCacheAdminStatus = await import("../../../../packages/server/src/images/ready-cache/admin-status.ts");
const redisInspect = await import("../../../../packages/server/src/checks/redis-inspect.ts");
const vocabCache = await import("../../../../packages/server/src/vocab/vocab-cache.ts");
const runtimeAvailability = await import("../../../../packages/server/src/core/runtime-availability.ts");
await runtimeAvailability.requireOperationalRedis();
const readReadyRevision = async () => BigInt(String((
  await database.pool.query(
    "SELECT revision::text FROM ready_image_revision WHERE singleton=1"
  )
).rows[0].revision));
  const imageUpdateIds = {
    first: randomUUID(),
    missing: randomUUID(),
    third: randomUUID(),
    fourth: randomUUID()
  };
  for (const [index, id] of [
    imageUpdateIds.first,
    imageUpdateIds.third,
    imageUpdateIds.fourth
  ].entries()) {
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
        + "theme, ext, md5) VALUES ($1, 'integration-admin', 'local', $2, 'pc', 'dark', "
        + "'none', 'webp', $3)",
      [
        id,
        imagePaths.storageObjectKey(id, "webp"),
        String(index + 1).repeat(32)
      ]
    );
  }
  const readyCacheStatus = await readyCacheCoordinator
    .initializeReadyImageCacheCoordinator();
  assert.equal(readyCacheStatus.readable, true);
  const initialReadyMeta = readyCacheStatus.meta;
  assert.ok(initialReadyMeta);
  assert.equal(initialReadyMeta.state, "ready");
  assert.equal(initialReadyMeta.itemCount, 3);
  assert.equal(initialReadyMeta.processed, 0);
  assert.equal(initialReadyMeta.total, 0);
  assert.ok(Number.isFinite(Date.parse(initialReadyMeta.lastUpdatedAt)));
  assert.ok(Number.isFinite(Date.parse(initialReadyMeta.fullRebuildStartedAt)));
  assert.ok(Number.isFinite(Date.parse(initialReadyMeta.fullRebuildCompletedAt)));
  assert.ok((initialReadyMeta.lastFullRebuildCoreMemoryBytes ?? 0) > 0);
  assert.ok(Number.isFinite(Date.parse(
    initialReadyMeta.lastFullRebuildMeasuredAt
  )));
  const initialFullRebuildSnapshot = {
    startedAt: initialReadyMeta.fullRebuildStartedAt,
    completedAt: initialReadyMeta.fullRebuildCompletedAt,
    memoryBytes: initialReadyMeta.lastFullRebuildCoreMemoryBytes,
    measuredAt: initialReadyMeta.lastFullRebuildMeasuredAt
  };


  const manyImageUpdate = await imageUpdate.updateImages([
    { id: imageUpdateIds.first, title: "first" },
    { id: imageUpdateIds.missing, title: "missing" },
    { id: imageUpdateIds.third, description: "third" }
  ]);
  assert.deepEqual(
    manyImageUpdate.results.map((result) => [
      result.id,
      result.status,
      result.status === "failed" ? result.code : null
    ]),
    [
      [imageUpdateIds.first, "updated", null],
      [imageUpdateIds.missing, "failed", "not_found"],
      [imageUpdateIds.third, "updated", null]
    ]
  );
  assert.equal(manyImageUpdate.updated, 2);
  assert.equal(manyImageUpdate.failed, 1);
  const incrementalMeta = await readyCacheMeta.readReadyImageCacheMeta();
  assert.ok(incrementalMeta);
  assert.equal(incrementalMeta.itemCount, 3);
  assert.equal(incrementalMeta.processed, 0);
  assert.equal(incrementalMeta.total, 0);
  assert.deepEqual({
    startedAt: incrementalMeta.fullRebuildStartedAt,
    completedAt: incrementalMeta.fullRebuildCompletedAt,
    memoryBytes: incrementalMeta.lastFullRebuildCoreMemoryBytes,
    measuredAt: incrementalMeta.lastFullRebuildMeasuredAt
  }, initialFullRebuildSnapshot);
  assert.ok(
    Date.parse(incrementalMeta.lastUpdatedAt)
      >= Date.parse(initialReadyMeta.lastUpdatedAt)
  );
  const incrementalStatus = await readyCacheAdminStatus
    .readReadyImageCacheAdminStatus(
      String(await readReadyRevision())
    );
  assert.equal(incrementalStatus.item_count, 3);
  assert.equal(incrementalStatus.processed, null);
  assert.equal(incrementalStatus.total, null);
  assert.equal(
    incrementalStatus.last_updated_at,
    incrementalMeta.lastUpdatedAt
  );
  assert.equal(incrementalStatus.full_rebuild_duration_ms, Math.max(
    0,
    Date.parse(incrementalMeta.fullRebuildCompletedAt)
      - Date.parse(incrementalMeta.fullRebuildStartedAt)
  ));

  const redisDeepCheck = await redisInspect.inspectRedisState(undefined, {
    deadlineMs: 5_000,
    maxKeys: 10_000,
    pipelineMaxCommands: 16
  });
  assert.equal(redisDeepCheck.deep_inspection.complete, true);
  assert.equal(redisDeepCheck.deep_inspection.source, "deep");
  assert.ok(Number.isFinite(Date.parse(
    redisDeepCheck.deep_inspection.measured_at
  )));
  assert.equal(
    redisDeepCheck.deep_inspection.image_projection_usage.core.key_count,
    8
  );
  assert.ok(
    redisDeepCheck.deep_inspection.image_projection_usage.core.member_count
      >= incrementalMeta.itemCount
  );
  let deepCursor = "0";
  const directCoreKeys = new Set<string>();
  do {
    const [nextCursor, keys] = await redisClient.redis.scan(
      deepCursor,
      "MATCH",
      "imageshow:cache:images:*",
      "COUNT",
      100
    );
    deepCursor = nextCursor;
    for (const key of keys) {
      if (!key.startsWith("imageshow:cache:images:derived:")) {
        directCoreKeys.add(key);
      }
    }
  } while (deepCursor !== "0");
  const directCoreMemory = (await Promise.all(
    [...directCoreKeys].map((key) => redisClient.redis.call(
      "MEMORY",
      "USAGE",
      key,
      "SAMPLES",
      "0"
    ))
  )).reduce<number>((sum, value) => sum + Number(value ?? 0), 0);
  assert.equal(
    redisDeepCheck.deep_inspection.image_projection_usage.core.memory_bytes,
    directCoreMemory
  );
  const singleImageUpdate = await imageUpdate.updateImages([{
    id: imageUpdateIds.first,
    title: "single"
  }]);
  assert.deepEqual(singleImageUpdate, {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.deepEqual(
    (await database.pool.query(
      "SELECT id::text, title, description FROM metadata "
        + "WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[imageUpdateIds.first, imageUpdateIds.third]]
    )).rows,
    [
      { id: imageUpdateIds.first, title: "single", description: "" },
      { id: imageUpdateIds.third, title: "", description: "third" }
    ].sort((left, right) => left.id.localeCompare(right.id))
  );

  const readAtomicImage = async (id: string) => (await database.pool.query(
    `SELECT title, ARRAY(
       SELECT tag_slug FROM image_tag
        WHERE image_id=metadata.id ORDER BY tag_slug
     ) AS tags
       FROM metadata WHERE id=$1`,
    [id]
  )).rows[0];

  const revisionBeforeAtomicUpdate = await readReadyRevision();
  assert.equal((await imageUpdate.updateImages([{
    id: imageUpdateIds.first,
    title: "atomic",
    tags: ["atomic-tag"]
  }])).failed, 0);
  assert.equal(await readReadyRevision(), revisionBeforeAtomicUpdate + 1n);
  assert.deepEqual(await readAtomicImage(imageUpdateIds.first), {
    title: "atomic",
    tags: ["atomic-tag"]
  });

  const revisionBeforeNoop = await readReadyRevision();
  assert.deepEqual(await imageUpdate.updateImages([{
    id: imageUpdateIds.first,
    title: "atomic",
    tags: ["atomic-tag"]
  }]), {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.equal(await readReadyRevision(), revisionBeforeNoop);

  assert.equal((await imageUpdate.updateImages([{
    id: imageUpdateIds.third,
    title: "stable",
    tags: ["stable-tag"]
  }])).failed, 0);
  await database.pool.query(`
    CREATE OR REPLACE FUNCTION imageshow_test_reject_atomic_tag()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.tag_slug = 'atomic-fail' THEN
        RAISE EXCEPTION 'forced atomic image update failure';
      END IF;
      RETURN NEW;
    END;
    $function$;
    CREATE TRIGGER imageshow_test_reject_atomic_tag
      BEFORE INSERT ON image_tag
      FOR EACH ROW EXECUTE FUNCTION imageshow_test_reject_atomic_tag();
  `);
  const revisionBeforeRollback = await readReadyRevision();
  const rolledBackUpdate = await imageUpdate.updateImages([{
    id: imageUpdateIds.third,
    title: "rolled-back",
    tags: ["atomic-fail"]
  }]);
  assert.equal(rolledBackUpdate.updated, 0);
  assert.equal(rolledBackUpdate.failed, 1);
  assert.equal(rolledBackUpdate.results[0]?.status, "failed");
  assert.equal(await readReadyRevision(), revisionBeforeRollback);
  assert.deepEqual(await readAtomicImage(imageUpdateIds.third), {
    title: "stable",
    tags: ["stable-tag"]
  });
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM tag WHERE slug='atomic-fail'"
  )).rows[0].count), 0);
  await database.pool.query(`
    DROP TRIGGER imageshow_test_reject_atomic_tag ON image_tag;
    DROP FUNCTION imageshow_test_reject_atomic_tag();
  `);

  const revisionBeforeOverlap = await readReadyRevision();
  const completionOrder: string[] = [];
  const leftUpdate = imageUpdate.updateImages([
    { id: imageUpdateIds.first, description: "left-a" },
    { id: imageUpdateIds.third, title: "left-b", tags: ["left-tag"] }
  ]).then((result) => {
    completionOrder.push("left");
    return result;
  });
  const rightUpdate = imageUpdate.updateImages([
    { id: imageUpdateIds.third, title: "right-b", tags: ["right-tag"] },
    { id: imageUpdateIds.fourth, description: "right-c" }
  ]).then((result) => {
    completionOrder.push("right");
    return result;
  });
  const overlappingResults = await Promise.all([leftUpdate, rightUpdate]);
  assert.deepEqual(
    overlappingResults.map((result) => result.results.map((item) => item.status)),
    [["updated", "updated"], ["updated", "updated"]]
  );
  assert.equal(await readReadyRevision(), revisionBeforeOverlap + 4n);
  const expectedLastWriter = completionOrder.at(-1);
  assert.deepEqual(
    await readAtomicImage(imageUpdateIds.third),
    expectedLastWriter === "left"
      ? { title: "left-b", tags: ["left-tag"] }
      : { title: "right-b", tags: ["right-tag"] }
  );

  await readyCacheCoordinator.ensureReadyImageCacheCurrent();
  const revisionBeforeReadyCacheFailure = await readReadyRevision();
  const originalRedisSendCommand = redisClient.redis.sendCommand;
  let readyCacheFailureInjected = false;
  const observedRedisCommands: string[] = [];
  redisClient.redis.sendCommand = async function (command, ...args) {
    observedRedisCommands.push(command.name);
    if (command.name !== "ping" && !readyCacheFailureInjected) {
      readyCacheFailureInjected = true;
      throw new Error("injected ready-image cache publish failure");
    }
    return originalRedisSendCommand.call(this, command, ...args);
  };
  await redisClient.redis.ping();
  assert.deepEqual(observedRedisCommands, ["ping"]);
  assert.equal(
    readyCacheCoordinator.getReadyImageCacheCoordinatorStatus().readable,
    true
  );
  let committedThroughReadyCacheFailure;
  try {
    committedThroughReadyCacheFailure = await imageUpdate.updateImages([{
      id: imageUpdateIds.first,
      source: "https://example.com/ready-cache-failure-committed"
    }]);
  } finally {
    redisClient.redis.sendCommand = originalRedisSendCommand;
  }
  assert.deepEqual(committedThroughReadyCacheFailure, {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.equal(readyCacheFailureInjected, true);
  assert.equal(await readReadyRevision(), revisionBeforeReadyCacheFailure + 1n);
  assert.equal((await database.pool.query(
    "SELECT source FROM metadata WHERE id=$1",
    [imageUpdateIds.first]
  )).rows[0]?.source, "https://example.com/ready-cache-failure-committed");
  assert.equal(
    (await readyCacheCoordinator.ensureReadyImageCacheCurrent()).appliedRevision,
    String(await readReadyRevision())
  );

  await vocabCache.getTagVocab();
  await vocabCache.getAdminTagList();
  const revisionBeforeVocabularyCacheFailure = await readReadyRevision();
  const originalRedisUnlink = redisClient.redis.unlink;
  const originalRedisSet = redisClient.redis.set;
  let failedUnlinkCalls = 0;
  let failedSetCalls = 0;
  redisClient.redis.unlink = async function () {
    failedUnlinkCalls += 1;
    throw new Error("injected entity cache unlink failure");
  };
  redisClient.redis.set = async function () {
    failedSetCalls += 1;
    throw new Error("injected vocabulary cache set failure");
  };
  let committedThroughVocabularyCacheFailure;
  try {
    committedThroughVocabularyCacheFailure = await imageUpdate.updateImages([{
      id: imageUpdateIds.first,
      tags: ["cache-repair-tag"]
    }]);
  } finally {
    redisClient.redis.unlink = originalRedisUnlink;
    redisClient.redis.set = originalRedisSet;
  }
  assert.ok(failedUnlinkCalls >= 2);
  assert.ok(failedSetCalls >= 1);
  assert.deepEqual(committedThroughVocabularyCacheFailure, {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.equal(
    await readReadyRevision(),
    revisionBeforeVocabularyCacheFailure + 1n
  );
  assert.deepEqual(await readAtomicImage(imageUpdateIds.first), {
    title: "atomic",
    tags: ["cache-repair-tag"]
  });
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM tag WHERE slug='cache-repair-tag'"
  )).rows[0].count), 1);

  await database.pool.query(
    "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
    [[imageUpdateIds.first, imageUpdateIds.third, imageUpdateIds.fourth]]
  );
  await database.pool.query(
    "DELETE FROM tag WHERE slug=ANY($1::text[])",
    [[
      "atomic-tag",
      "stable-tag",
      "left-tag",
      "right-tag",
      "atomic-fail",
      "cache-repair-tag"
    ]]
  );
});
