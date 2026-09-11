import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { runIntegrationScenario } from "./integration-runtime.mts";
import { interceptPoolConnections, interceptSqlQueries } from "./database-faults.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const redisClient = await import("../../../../packages/server/src/core/redis/client.ts");
const runtimeAvailability = await import("../../../../packages/server/src/core/runtime-availability.ts");
const readyCacheCoordinator = await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
const ingestionOrphanCleanup = await import("../../../../packages/server/src/images/ingestion/cleanup/orphans.ts");
const adminImagesReadModel = await import("../../../../packages/server/src/images/read-models/admin-images.ts");
const publicImagesReadModel = await import("../../../../packages/server/src/images/read-models/public-images.ts");
const imageFilterPlan = await import("../../../../packages/server/src/images/filter-plan.ts");
const readyCacheFilterIndex = await import("../../../../packages/server/src/images/ready-cache/indexes/filter.ts");
const vocabCache = await import("../../../../packages/server/src/vocab/vocab-cache.ts");
await runtimeAvailability.requireOperationalRedis();
const duplicates = await import("../../../../packages/server/src/images/read-models/duplicates.ts");
const duplicateIds = [randomUUID(), randomUUID()];
const duplicateMd5 = createHash("md5").update("duplicate-authority").digest("hex");
try {
  for (const [index, id] of duplicateIds.entries()) {
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, status) VALUES "
        + "($1, 'integration-admin', 'local', $2, 'pc', 'dark', NULL, 'webp', $3, $4)",
      [id, imagePaths.storageObjectKey(id, "webp"), duplicateMd5, index === 0 ? "ready" : "deleted"]
    );
  }
  const snapshots = await duplicates.readDuplicateSnapshotsByMd5([duplicateMd5, "f".repeat(32)]);
  const snapshot = snapshots.get(duplicateMd5);
  assert.ok(snapshot);
  assert.equal(snapshot.matchCount, 1);
  assert.deepEqual(snapshot.items.map((item) => item.id), [duplicateIds[0]]);
  assert.deepEqual(snapshots.get("f".repeat(32)), { matchCount: 0, items: [] });
  await database.pool.query("UPDATE metadata SET status='deleted' WHERE id=$1", [duplicateIds[0]]);
  assert.deepEqual(await duplicates.readDuplicateSnapshotByMd5(duplicateMd5), {
    matchCount: 0, items: []
  }, "duplicate results must follow current PostgreSQL ready rows");
} finally {
  await database.pool.query("DELETE FROM metadata WHERE id=ANY($1::uuid[])", [duplicateIds]);
}
await readyCacheCoordinator.initializeReadyImageCacheCoordinator();
  const paginationIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationNewest = "2026-08-15T00:00:00.000Z";
  const paginationOlder = "2026-08-14T00:00:00.000Z";
  await database.pool.query(
    "INSERT INTO tag(slug, display_name) VALUES "
      + "('pagination-old', 'Pagination old'), "
      + "('pagination-new', 'Pagination new') "
      + "ON CONFLICT (slug) DO NOTHING"
  );
  await database.pool.query(
    "INSERT INTO author(slug, display_name) VALUES "
      + "('alice', 'Alice'), ('bob', 'Bob') "
      + "ON CONFLICT (slug) DO NOTHING"
  );
  for (const [position, id] of paginationIds.entries()) {
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, author, image_time, deleted_at, title) "
        + "VALUES ($1, 'integration-admin', 'deleted', 'local', $2, 'pc', 'dark', NULL, "
        + "'webp', $3, $4, $5, now(), $6)",
      [
        id,
        imagePaths.storageObjectKey(id, "webp"),
        String(position + 4).repeat(32),
        position === 2 ? "bob" : "alice",
        position === 2 ? paginationOlder : paginationNewest,
        "pagination-" + String(position)
      ]
    );
  }
  await database.pool.query(
    "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, 'pagination-old')",
    [paginationIds[0]]
  );
  const initialPaginationOrder = [
    ...paginationIds.slice(0, 2).sort().reverse(),
    paginationIds[2]
  ];
  const firstDeletedPage = await adminImagesReadModel.listAdminImages({
    status: "deleted",
    page: 1,
    limit: 2
  });
  assert.equal(firstDeletedPage.total, 3);
  assert.deepEqual(
    firstDeletedPage.items.map((item) => item.id),
    initialPaginationOrder.slice(0, 2)
  );

  let pageWindowSelects = 0;
  const restorePageWindows = interceptPoolConnections(database.pool, (client) =>
    interceptSqlQueries(client, (text, _values, query) => {
      if (/ORDER BY image_time DESC, id DESC[\s\S]*OFFSET/.test(text)) {
        pageWindowSelects += 1;
      }
      return query();
    }));
  try {
    const outside = await adminImagesReadModel.listAdminImages({
      status: "deleted",
      page: 10_000,
      limit: 2
    });
    assert.deepEqual(outside, { items: [], total: 3 });
    assert.equal(pageWindowSelects, 0);
  } finally {
    restorePageWindows();
  }

  let countObserved!: () => void;
  const countReached = new Promise<void>((resolve) => {
    countObserved = resolve;
  });
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let snapshotConnectionWrapped = false;
  const restoreSnapshot = interceptPoolConnections(database.pool, (client) => {
    if (snapshotConnectionWrapped) return;
    snapshotConnectionWrapped = true;
    let gated = false;
    return interceptSqlQueries(client, async (sql, _values, query) => {
      const result = await query();
      if (
        !gated
        && /^SELECT count\(\*\)::text AS count FROM metadata WHERE/.test(
          sql.trim()
        )
      ) {
        gated = true;
        countObserved();
        await snapshotGate;
      }
      return result;
    });
  });
  const snapshotRead = adminImagesReadModel.listAdminImages({
    status: "deleted",
    page: 1,
    limit: 10
  });
  const concurrentPaginationId = randomUUID();
  let snapshotPage;
  try {
  await Promise.race([countReached, snapshotRead.then(() => assert.fail("snapshot count must be intercepted"))]);
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, author, image_time, deleted_at, title) "
      + "VALUES ($1, 'integration-admin', 'deleted', 'local', $2, 'pc', 'dark', NULL, "
      + "'webp', $3, 'alice', '2026-08-16T00:00:00.000Z', now(), "
      + "'pagination-concurrent')",
    [
      concurrentPaginationId,
      imagePaths.storageObjectKey(concurrentPaginationId, "webp"),
      "8".repeat(32)
    ]
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [paginationIds[2]]
  );
  await database.pool.query(
    "DELETE FROM image_tag WHERE image_id=$1",
    [paginationIds[0]]
  );
  await database.pool.query(
    "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, 'pagination-new')",
    [paginationIds[0]]
  );
  releaseSnapshot();
    snapshotPage = await snapshotRead;
  } finally {
    releaseSnapshot();
    try {
      await snapshotRead;
    } finally {
      restoreSnapshot();
    }
  }
  assert.equal(snapshotPage.total, 3);
  assert.deepEqual(
    snapshotPage.items.map((item) => item.id),
    initialPaginationOrder
  );
  assert.deepEqual(
    snapshotPage.items.find((item) => item.id === paginationIds[0])?.tags,
    ["pagination-old"]
  );
  const currentDeletedPage = await adminImagesReadModel.listAdminImages({
    status: "deleted",
    page: 1,
    limit: 10
  });
  assert.equal(currentDeletedPage.total, 3);
  assert.equal(
    currentDeletedPage.items.some((item) => item.id === concurrentPaginationId),
    true
  );
  assert.equal(
    currentDeletedPage.items.some((item) => item.id === paginationIds[2]),
    false
  );
  assert.deepEqual(
    currentDeletedPage.items.find(
      (item) => item.id === paginationIds[0]
    )?.tags,
    ["pagination-new"]
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
    [[...paginationIds, concurrentPaginationId]]
  );
  await database.pool.query(
    "DELETE FROM tag WHERE slug IN ('pagination-old', 'pagination-new')"
  );
  await database.pool.query(
    "DELETE FROM author WHERE slug IN ('alice', 'bob')"
  );

  const matrixTheme = "pagination-matrix";
  const matrixTag = "pagination-matrix";
  const matrixExtraTag = "pagination-extra";
  const matrixAuthor = "pagination-matrix";
  const matrixIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ];
  const matrixTime = "2026-08-17T00:00:00.000Z";
  await database.pool.query(
    "INSERT INTO theme(slug, display_name) VALUES ($1, 'Pagination matrix')",
    [matrixTheme]
  );
  await database.pool.query(
    "INSERT INTO tag(slug, display_name) VALUES "
      + "($1, 'Pagination matrix'), ($2, 'Pagination extra')",
    [matrixTag, matrixExtraTag]
  );
  await database.pool.query(
    "INSERT INTO author(slug, display_name) VALUES ($1, 'Pagination matrix')",
    [matrixAuthor]
  );
  const matrixAxes = [
    ["pc", "dark"],
    ["pc", "dark"],
    ["mb", "light"],
    ["pc", "light"],
    ["mb", "dark"],
    ["mb", "dark"]
  ];
  for (const [position, id] of matrixIds.entries()) {
    const [device, brightness] = matrixAxes[position];
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, author, image_time, title) "
        + "VALUES ($1, 'integration-admin', 'ready', 'local', $2, $3, $4, $5, 'webp', $6, $7, $8, $9)",
      [
        id,
        imagePaths.storageObjectKey(id, "webp"),
        device,
        brightness,
        matrixTheme,
        createHash("md5").update(id).digest("hex"),
        matrixAuthor,
        matrixTime,
        "pagination-matrix-" + String(position)
      ]
    );
    await database.pool.query(
      "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, $2)",
      [id, matrixTag]
    );
  }
  await database.pool.query(
    "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, $2)",
    [matrixIds[0], matrixExtraTag]
  );
  await vocabCache.refreshEntityVocabularies(["theme", "tag", "author"]);
  await runtimeAvailability.requireOperationalRedis();
  await readyCacheCoordinator.requestReadyImageCacheRebuild();
  assert.equal(
    readyCacheCoordinator.getReadyImageCacheCoordinatorStatus().readable,
    true
  );

  const readyPageMatrix: Array<{
    name: string;
    query: Parameters<typeof adminImagesReadModel.listAdminImages>[0];
  }> = [
    {
      name: "all",
      query: { status: "ready", page: 1, limit: 3 }
    },
    {
      name: "unset",
      query: { status: "ready", theme: "~unset", page: 1, limit: 3 }
    },
    {
      name: "device",
      query: { status: "ready", device: "mb", page: 1, limit: 3 }
    },
    {
      name: "brightness",
      query: { status: "ready", brightness: "light", page: 1, limit: 3 }
    },
    {
      name: "theme-first",
      query: { status: "ready", theme: matrixTheme, page: 1, limit: 3 }
    },
    {
      name: "theme-exact-last",
      query: { status: "ready", theme: matrixTheme, page: 2, limit: 3 }
    },
    {
      name: "tag",
      query: { status: "ready", tag: matrixTag, page: 1, limit: 6 }
    },
    {
      name: "author",
      query: { status: "ready", author: matrixAuthor, page: 1, limit: 6 }
    },
    {
      name: "combined",
      query: {
        status: "ready",
        device: "pc",
        brightness: "dark",
        theme: matrixTheme,
        tag: matrixTag,
        author: matrixAuthor,
        page: 1,
        limit: 2
      }
    },
    {
      name: "zero",
      query: {
        status: "ready",
        tag: "pagination-missing",
        page: 1,
        limit: 2
      }
    }
  ];
  for (const entry of readyPageMatrix) {
    const plan = await imageFilterPlan.resolveImageFilterPlan(
      entry.query,
      { redisMode: "required" }
    );
    assert.ok(
      await readyCacheFilterIndex.resolveReadyImageFilterIndex(plan),
      "matrix index must be warm: " + entry.name
    );
  }

  const redisMatrixPages = new Map<string, Awaited<ReturnType<typeof adminImagesReadModel.listAdminImages>>>();
  const publicCursorPages: Array<{
    query: Parameters<typeof publicImagesReadModel.listPublicImages>[0];
    page: Awaited<ReturnType<typeof publicImagesReadModel.listPublicImages>>;
  }> = [];
  let redisMatrixConnections = 0;
  const restoreMatrixConnections = interceptPoolConnections(database.pool, () => {
    redisMatrixConnections += 1;
  });
  try {
    for (const entry of readyPageMatrix) {
      const connectionsBefore = redisMatrixConnections;
      redisMatrixPages.set(
        entry.name,
        await adminImagesReadModel.listAdminImages(entry.query)
      );
      assert.equal(
        redisMatrixConnections,
        connectionsBefore,
        "matrix entry must stay on Redis: " + entry.name
      );
    }
    for (const order of ["latest", "oldest"] as const) {
      const orderedIds = [...matrixIds].sort();
      if (order === "latest") orderedIds.reverse();
      let cursor;
      for (const pageIndex of [0, 1]) {
        const query = {
          status: "ready", view: "gallery", theme: matrixTheme, limit: 3, order, cursor
        } as const;
        const page = await publicImagesReadModel.listPublicImages(
          query, new AbortController().signal
        );
        assert.deepEqual(
          page.items.map((item) => item.id),
          orderedIds.slice(pageIndex * 3, (pageIndex + 1) * 3),
          "public cursor must preserve time/ID order without repeating its anchor: " + order
        );
        assert.equal(
          redisMatrixConnections, 0,
          "both public cursor directions must stay on warm Redis: " + order
        );
        if (pageIndex === 0) assert.ok(page.next_cursor);
        else assert.equal(page.next_cursor, null, "exact final page must terminate the cursor");
        publicCursorPages.push({ query, page });
        cursor = page.next_cursor ?? undefined;
      }
    }
  } finally {
    restoreMatrixConnections();
  }
  assert.equal(redisMatrixConnections, 0);
  const matrixOrder = [...matrixIds].sort().reverse();
  const firstThemePage = redisMatrixPages.get("theme-first");
  const lastThemePage = redisMatrixPages.get("theme-exact-last");
  assert.ok(firstThemePage && lastThemePage);
  assert.equal(firstThemePage.total, 6);
  assert.equal(lastThemePage.total, 6);
  assert.deepEqual(
    firstThemePage.items.map((item) => item.id),
    matrixOrder.slice(0, 3)
  );
  assert.deepEqual(
    lastThemePage.items.map((item) => item.id),
    matrixOrder.slice(3)
  );
  assert.equal(lastThemePage.items.length, 3, "末页恰好填满时不得少读");
  assert.deepEqual(redisMatrixPages.get("zero"), { items: [], total: 0 });
  assert.deepEqual(
    redisMatrixPages.get("combined")!.items.map((item) => item.id),
    matrixOrder.filter((id) => matrixIds.slice(0, 2).includes(id))
  );
  assert.deepEqual(
    redisMatrixPages.get("tag")!.items.find(
      (item) => item.id === matrixIds[0]
    )?.tags,
    [matrixExtraTag, matrixTag]
  );

  const rebuildingRedisSendCommand = redisClient.redis.sendCommand;
  let rebuildCommandObserved!: () => void;
  const rebuildCommandStarted = new Promise<void>((resolve) => {
    rebuildCommandObserved = resolve;
  });
  let releaseRebuildCommand!: () => void;
  const rebuildCommandGate = new Promise<void>((resolve) => {
    releaseRebuildCommand = resolve;
  });
  let rebuildCommandHeld = false;
  redisClient.redis.sendCommand = async function (command, ...args) {
    if (command.name !== "ping" && !rebuildCommandHeld) {
      rebuildCommandHeld = true;
      rebuildCommandObserved();
      await rebuildCommandGate;
    }
    return rebuildingRedisSendCommand.call(this, command, ...args);
  };
  const controlledRebuild =
    readyCacheCoordinator.requestReadyImageCacheRebuild();
  let restoreFallbackConnections = () => {};
  try {
  await Promise.race([rebuildCommandStarted, controlledRebuild.then(() => assert.fail("rebuild must be intercepted"))]);
  assert.equal(
    readyCacheCoordinator.getReadyImageCacheCoordinatorStatus().rebuilding,
    true
  );
  let rebuildingFallbackConnections = 0;
  restoreFallbackConnections = interceptPoolConnections(database.pool, () => {
    rebuildingFallbackConnections += 1;
  });
    for (const entry of readyPageMatrix) {
      const rebuildingFallback = await adminImagesReadModel.listAdminImages(
        entry.query
      );
      assert.deepEqual(
        rebuildingFallback,
        redisMatrixPages.get(entry.name),
        "Redis 与 PostgreSQL 页结果必须一致: " + entry.name
      );
    }
    for (const { query, page } of publicCursorPages) {
      assert.deepEqual(
        await publicImagesReadModel.listPublicImages(
          query, new AbortController().signal
        ),
        page,
        "public Redis/PostgreSQL cursor pages must agree: " + query.order
      );
    }
    assert.equal(
      rebuildingFallbackConnections,
      readyPageMatrix.length + publicCursorPages.length
    );
  } finally {
    restoreFallbackConnections();
    releaseRebuildCommand();
    try {
      await controlledRebuild;
    } finally {
      redisClient.redis.sendCommand = rebuildingRedisSendCommand;
    }
  }

  const paginationRedisSendCommand = redisClient.redis.sendCommand;
  const interruptedRedis = new Error("controlled ready page zcard failure");
  let pageZcardCommands = 0;
  let interruptedPageConnections = 0;
  const restoreInterruptedPage = interceptPoolConnections(database.pool, () => {
    interruptedPageConnections += 1;
  });
  redisClient.redis.sendCommand = async function (command, ...args) {
    if (command.name === "zcard" && ++pageZcardCommands === 2) {
      throw interruptedRedis;
    }
    return paginationRedisSendCommand.call(this, command, ...args);
  };
  try {
    await assert.rejects(
      adminImagesReadModel.listAdminImages({
        status: "ready",
        page: 1,
        limit: 1
      }),
      (error: unknown) => error instanceof Error && error.name === "redis_unavailable"
    );
    assert.equal(interruptedPageConnections, 0);
  } finally {
    redisClient.redis.sendCommand = paginationRedisSendCommand;
    restoreInterruptedPage();
  }
  assert.deepEqual(await ingestionOrphanCleanup.cleanupIngestionOrphans(), {
    skipped: true,
    raw_removed: 0,
    staging_removed: 0,
    staging_failed: 0,
    incomplete_namespaces: 0,
    incomplete_raw_scans: 0
  });
  await runtimeAvailability.requireOperationalRedis();
  await readyCacheCoordinator.requestReadyImageCacheRebuild();

  const vocabularyRedisSendCommand = redisClient.redis.sendCommand;
  const interruptedVocabulary = new Error("controlled vocabulary GET failure");
  let vocabularyCommandInterrupted = false;
  let interruptedVocabularyConnections = 0;
  const restoreInterruptedVocabulary = interceptPoolConnections(database.pool, () => {
    interruptedVocabularyConnections += 1;
  });
  redisClient.redis.sendCommand = async function (command, ...args) {
    if (command.name === "get" && !vocabularyCommandInterrupted) {
      vocabularyCommandInterrupted = true;
      throw interruptedVocabulary;
    }
    return vocabularyRedisSendCommand.call(this, command, ...args);
  };
  try {
    await assert.rejects(
      adminImagesReadModel.listAdminImages({
        status: "ready",
        theme: "~unset",
        page: 1,
        limit: 1
      }),
      (error: unknown) => error instanceof Error && error.name === "redis_unavailable"
    );
    assert.equal(interruptedVocabularyConnections, 0);
  } finally {
    redisClient.redis.sendCommand = vocabularyRedisSendCommand;
    restoreInterruptedVocabulary();
  }
  await runtimeAvailability.requireOperationalRedis();
  await readyCacheCoordinator.requestReadyImageCacheRebuild();

  await database.pool.query(
    "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
    [matrixIds]
  );
  await database.pool.query(
    "DELETE FROM tag WHERE slug = ANY($1::text[])",
    [[matrixTag, matrixExtraTag]]
  );
  await database.pool.query("DELETE FROM theme WHERE slug=$1", [matrixTheme]);
  await database.pool.query("DELETE FROM author WHERE slug=$1", [matrixAuthor]);

});
