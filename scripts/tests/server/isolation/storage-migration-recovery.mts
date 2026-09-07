import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { removeDriverObject } from "./storage-fixture.mts";
import { interceptSqlQueries, withCommitFault } from "./database-faults.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const registryConfig = {
  endpoint: "https://objects.example.com", region: "ap-southeast-1",
  bucket: "gallery", access_key_id: "key", secret_access_key: "secret",
  force_path_style: false, root_path: "/images", public_base_url: "https://cdn.example.com",
  connect_timeout_seconds: 15, idle_timeout_seconds: 15, task_timeout_seconds: 300
};
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const registry = await import("../../../../packages/server/src/storage/backends/registry.ts");
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const storageMigration = await import("../../../../packages/server/src/images/storage-location/image-migration.ts");
const storageMigrationAdmission = await import(
  "../../../../packages/server/src/storage/objects/image-transfer-admission.ts"
);
const imageStorageMigration = await import("../../../../packages/server/src/images/storage-location/selected-images-migration.ts");
const backendMigration = await import("../../../../packages/server/src/images/storage-location/storage-backend-migration.ts");
const apiError = await import("../../../../packages/server/src/core/api-error.ts");
const localAccess = await registry.resolveStorageAccess("local");
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ('local-migration', 'Local migration', 'local', true)"
  );
  registry.invalidateStorageBackendRegistry();
  const migrationIds = {
    migrated: randomUUID(),
    notFound: randomUUID(),
    sourceMissing: randomUUID(),
    unchanged: randomUUID(),
    failed: randomUUID()
  };
  const addMigrationImage = async (id: string, storageSlug: string, body: Buffer | null, md5?: string) => {
    const key = imagePaths.storageObjectKey(id, "webp");
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
        + "theme, ext, md5, image_size, thumbnail_size, status, deleted_at) VALUES "
        + "($1, 'integration-admin', $2, $3, 'pc', 'dark', 'none', 'webp', $4, $5, $5, "
        + "'deleted', now())",
      [
        id,
        storageSlug,
        key,
        md5 ?? createHash("md5").update(body ?? Buffer.alloc(0)).digest("hex"),
        body?.byteLength ?? 0
      ]
    );
    if (body) {
      await localAccess.driver.writeBuffer("full", key, body, "image/webp");
      await localAccess.driver.writeBuffer(
        "thumbs",
        imagePaths.thumbnailObjectKey(key),
        body,
        "image/webp"
      );
    }
    return key;
  };
  const migratedKey = await addMigrationImage(
    migrationIds.migrated,
    "local",
    Buffer.from("migration-success")
  );
  await addMigrationImage(migrationIds.sourceMissing, "local", null);
  await addMigrationImage(
    migrationIds.unchanged,
    "local-migration",
    Buffer.from("migration-unchanged")
  );
  await addMigrationImage(
    migrationIds.failed,
    "local",
    Buffer.from("migration-integrity-failure"),
    "0".repeat(32)
  );
  const orderedMigrationIds = [
    migrationIds.failed,
    migrationIds.migrated,
    migrationIds.notFound,
    migrationIds.unchanged,
    migrationIds.sourceMissing
  ];
  const migrationReport = await imageStorageMigration.migrateSelectedImagesToStorageBackend(
    orderedMigrationIds,
    "local-migration"
  );
  assert.equal(migrationReport.requested, 5);
  assert.equal(migrationReport.migrated, 1);
  assert.equal(migrationReport.succeeded, 2);
  assert.equal(migrationReport.failed, 3);
  assert.deepEqual(
    migrationReport.results.map((result) => [
      result.id,
      result.status,
      result.status === "failed" ? result.code : null
    ]),
    [
      [migrationIds.failed, "failed", "storage_migration_failed"],
      [migrationIds.migrated, "migrated", null],
      [migrationIds.notFound, "failed", "not_found"],
      [migrationIds.unchanged, "unchanged", null],
      [migrationIds.sourceMissing, "failed", "source_missing"]
    ]
  );
  assert.deepEqual(
    (await imageStorageMigration.migrateSelectedImagesToStorageBackend(
      [migrationIds.unchanged],
      "local-migration"
    )).results,
    [{ id: migrationIds.unchanged, status: "unchanged" }]
  );
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [migrationIds.migrated]
    )).rows[0]?.storage_slug,
    "local-migration"
  );
  assert.equal(await localAccess.driver.exists("full", migratedKey), true);

  const thumbnailMissingMigrationId = randomUUID();
  const thumbnailMissingMigrationKey = imagePaths.storageObjectKey(thumbnailMissingMigrationId, "webp");
  const thumbnailMissingMigrationBody = Buffer.from(
    "migration-without-thumbnail"
  );
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, image_size, thumbnail_size) VALUES "
      + "($1, 'integration-admin', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, 0)",
    [
      thumbnailMissingMigrationId,
      thumbnailMissingMigrationKey,
      createHash("md5").update(thumbnailMissingMigrationBody).digest("hex"),
      thumbnailMissingMigrationBody.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    thumbnailMissingMigrationKey,
    thumbnailMissingMigrationBody,
    "image/webp"
  );
  const thumbnailMissingMigration = await imageStorageMigration
    .migrateSelectedImagesToStorageBackend(
      [thumbnailMissingMigrationId],
      "local-migration"
    );
  assert.deepEqual(thumbnailMissingMigration.results, [{
    id: thumbnailMissingMigrationId,
    status: "failed",
    code: "storage_thumbnail_missing",
    message: "图片当前位置的缩略图不存在，请先在检查页运行“存储维护”"
  }]);
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [thumbnailMissingMigrationId]
    )).rows[0]?.storage_slug,
    "local"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [thumbnailMissingMigrationId]
  );
  await removeDriverObject(localAccess.driver, "full", thumbnailMissingMigrationKey);

  const backendErrorIds = {
    missing: randomUUID(),
    known: randomUUID(),
    unknown: randomUUID()
  };
  await addMigrationImage(
    backendErrorIds.missing,
    "local-migration",
    null
  );
  const backendKnownErrorKey = await addMigrationImage(
    backendErrorIds.known,
    "local-migration",
    Buffer.from("backend-migration-known-error")
  );
  await removeDriverObject(
    localAccess.driver,
    "thumbs",
    imagePaths.thumbnailObjectKey(backendKnownErrorKey)
  );
  const backendUnknownErrorKey = await addMigrationImage(
    backendErrorIds.unknown,
    "local-migration",
    Buffer.from("backend-migration-unknown-error")
  );
  const originalBackendErrorOpenRead = localAccess.driver.openRead;
  localAccess.driver.openRead = async function (...args) {
    if (args[0] === "full" && args[1] === backendUnknownErrorKey) {
      throw new Error("injected backend migration driver failure");
    }
    return originalBackendErrorOpenRead.apply(this, args);
  };
  let backendMigrationReport;
  try {
    backendMigrationReport = await backendMigration.migrateStorageBackendImages(
      "local-migration",
      "local"
    );
  } finally {
    localAccess.driver.openRead = originalBackendErrorOpenRead;
  }
  assert.equal(backendMigrationReport.migration.source, "local-migration");
  assert.equal(backendMigrationReport.migration.target, "local");
  assert.equal(backendMigrationReport.migration.migrated, 2);
  assert.equal(backendMigrationReport.migration.missing, 1);
  assert.equal(backendMigrationReport.migration.error_count, 3);
  assert.equal(backendMigrationReport.migration.error_samples.length, 3);
  assert.equal("errors" in backendMigrationReport.migration, false);
  assert.ok(backendMigrationReport.migration.error_samples.every((sample) => (
    Object.keys(sample).sort().join(",") === "code,id,message,object_key"
      && typeof sample.message === "string"
      && sample.message.length > 0
  )));
  assert.deepEqual(
    Object.fromEntries(backendMigrationReport.migration.error_samples.map(
      ({ id, code }) => [id, code]
    )),
    {
      [backendErrorIds.missing]: "source_object_missing",
      [backendErrorIds.known]: "storage_thumbnail_missing",
      [backendErrorIds.unknown]: "storage_migration_failed"
    }
  );
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [migrationIds.migrated]
    )).rows[0]?.storage_slug,
    "local"
  );
  const backendErrorFixtureIds = Object.values(backendErrorIds);
  await database.pool.query(
    "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
    [backendErrorFixtureIds]
  );
  for (const key of [backendKnownErrorKey, backendUnknownErrorKey]) {
    await removeDriverObject(localAccess.driver, "full", key);
    await removeDriverObject(
      localAccess.driver,
      "thumbs",
      imagePaths.thumbnailObjectKey(key)
    );
  }

  const existingTargetSource = "migration-missing-source";
  const existingTargetDestination = "migration-existing-target";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, config, enabled) VALUES "
      + "($1, 'Migration missing source', 's3', $3::jsonb, true), "
      + "($2, 'Migration existing target', 's3', $4::jsonb, true)",
    [
      existingTargetSource,
      existingTargetDestination,
      JSON.stringify({
        ...registryConfig,
        bucket: "migration-missing-source",
        root_path: "/existing-target-regression"
      }),
      JSON.stringify({
        ...registryConfig,
        bucket: "migration-existing-target",
        root_path: "/existing-target-regression"
      })
    ]
  );
  registry.invalidateStorageBackendRegistry();
  const missingSourceAccess = await registry.resolveStorageAccess(
    existingTargetSource
  );
  const existingTargetAccess = await registry.resolveStorageAccess(
    existingTargetDestination
  );
  const originalMissingSourceOpenRead = missingSourceAccess.driver.openRead;
  const originalExistingTargetExists = existingTargetAccess.driver.exists;
  const originalExistingTargetOpenRead = existingTargetAccess.driver.openRead;
  const existingTargetIds = [randomUUID(), randomUUID()];
  const existingTargetKeys = new Set(existingTargetIds.map(
    (id) => imagePaths.storageObjectKey(id, "webp")
  ));
  let existingTargetDigestReads = 0;
  missingSourceAccess.driver.openRead = async function (prefix, key, ...rest) {
    if (prefix === "full" && existingTargetKeys.has(key)) {
      throw new apiError.ApiError(
        404,
        "storage_object_not_found",
        "Storage object not found"
      );
    }
    return originalMissingSourceOpenRead.call(this, prefix, key, ...rest);
  };
  existingTargetAccess.driver.exists = async function (prefix, key, ...rest) {
    if (prefix === "full" && existingTargetKeys.has(key)) return true;
    return originalExistingTargetExists.call(this, prefix, key, ...rest);
  };
  existingTargetAccess.driver.openRead = async function (prefix, key, ...rest) {
    if (prefix === "full" && existingTargetKeys.has(key)) {
      existingTargetDigestReads += 1;
      throw new Error("existing target must remain unread when source is missing");
    }
    return originalExistingTargetOpenRead.call(this, prefix, key, ...rest);
  };
  try {
    for (const [index, id] of existingTargetIds.entries()) {
      const key = imagePaths.storageObjectKey(id, "webp");
      const expectedBody = "existing-target-" + index;
      await database.pool.query(
        "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
          + "brightness, theme, ext, md5, image_size, thumbnail_size, status, "
          + "deleted_at) VALUES ($1, 'integration-admin', $2, $3, 'pc', 'dark', "
          + "'none', 'webp', $4, $5, $5, 'deleted', now())",
        [
          id,
          existingTargetSource,
          key,
          createHash("md5").update(expectedBody).digest("hex"),
          Buffer.byteLength(expectedBody)
        ]
      );
    }

    const existingTargetSourceRecord = (await database.pool.query(
      "SELECT id, object_key, ext, storage_slug, md5, image_size, thumbnail_size "
        + "FROM metadata WHERE id=$1",
      [existingTargetIds[0]]
    )).rows[0];
    assert.equal(
      await storageMigration.migrateImageToStorageBackend(
        existingTargetSourceRecord,
        existingTargetDestination
      ),
      "missing"
    );

    const selectedMissing = await imageStorageMigration.migrateSelectedImagesToStorageBackend(
      [existingTargetIds[0]],
      existingTargetDestination
    );
    assert.deepEqual(selectedMissing.results, [{
      id: existingTargetIds[0],
      status: "failed",
      code: "source_missing",
      message: "Image storage source is missing"
    }]);

    const backendExistingTargetMissing = await backendMigration
      .migrateStorageBackendImages(existingTargetSource, existingTargetDestination);
    assert.equal(backendExistingTargetMissing.migration.migrated, 0);
    assert.equal(backendExistingTargetMissing.migration.missing, 2);
    assert.equal(backendExistingTargetMissing.migration.error_count, 2);
    assert.deepEqual(
      Object.fromEntries(
        backendExistingTargetMissing.migration.error_samples.map(
          ({ id, code }) => [id, code]
        )
      ),
      Object.fromEntries(existingTargetIds.map((id) => [
        id,
        "source_object_missing"
      ]))
    );
    assert.equal(
      existingTargetDigestReads,
      0,
      "源对象缺失时选定迁移与后台迁移都不得读取或改写已有目标"
    );
  } finally {
    missingSourceAccess.driver.openRead = originalMissingSourceOpenRead;
    existingTargetAccess.driver.exists = originalExistingTargetExists;
    existingTargetAccess.driver.openRead = originalExistingTargetOpenRead;
    await database.pool.query(
      "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
      [existingTargetIds]
    );
    await database.pool.query(
      "DELETE FROM storage_backend WHERE slug=ANY($1::text[])",
      [[existingTargetSource, existingTargetDestination]]
    );
    registry.invalidateStorageBackendRegistry();
  }

  const backendOverflowSource = "local-migration-overflow";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ($1, 'Local migration overflow', 'local', true)",
    [backendOverflowSource]
  );
  registry.invalidateStorageBackendRegistry();
  const backendOverflowIds = [];
  for (let index = 0; index < 101; index += 1) {
    const id = randomUUID();
    backendOverflowIds.push(id);
    await addMigrationImage(id, backendOverflowSource, null);
  }
  const backendOverflowReport = await backendMigration.migrateStorageBackendImages(
    backendOverflowSource,
    "local"
  );
  assert.equal(backendOverflowReport.migration.missing, 101);
  assert.equal(backendOverflowReport.migration.error_count, 101);
  assert.equal(backendOverflowReport.migration.error_samples.length, 100);
  assert.equal("errors" in backendOverflowReport.migration, false);
  assert.deepEqual(
    backendOverflowReport.migration.error_samples.map(({ id }) => id),
    [...backendOverflowIds].sort().slice(0, 100),
    "错误总数保持权威，样本只保留稳定顺序的前 100 项"
  );
  assert.ok(backendOverflowReport.migration.error_samples.every(
    ({ code }) => code === "source_object_missing"
  ));
  await database.pool.query(
    "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
    [backendOverflowIds]
  );
  await database.pool.query(
    "DELETE FROM storage_backend WHERE slug=$1",
    [backendOverflowSource]
  );
  registry.invalidateStorageBackendRegistry();

  const waitForAbortReads = async (startedPromise: Promise<void>, label: string) => {
    let timer;
    try {
      await Promise.race([
        startedPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(label + " did not enter storage reads")),
            5_000
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const addAbortMigrationImage = async (id: string, storageSlug: string) => {
    const key = imagePaths.storageObjectKey(id, "webp");
    const body = Buffer.from("migration-abort-" + storageSlug + "-" + id);
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, image_size, thumbnail_size, status, deleted_at) "
        + "VALUES ($1, 'integration-admin', $2, $3, 'pc', 'dark', 'none', 'webp', $4, $5, $5, "
        + "'deleted', now())",
      [
        id,
        storageSlug,
        key,
        createHash("md5").update(body).digest("hex"),
        body.byteLength
      ]
    );
    await localAccess.driver.writeBuffer("full", key, body, "image/webp");
    await localAccess.driver.writeBuffer(
      "thumbs",
      imagePaths.thumbnailObjectKey(key),
      body,
      "image/webp"
    );
    return { id, key };
  };
  const removeAbortMigrationImages = async (fixtures: Array<{ id: string; key: string }>) => {
    for (const fixture of fixtures) {
      await removeDriverObject(localAccess.driver, "full", fixture.key);
      await removeDriverObject(
        localAccess.driver,
        "thumbs",
        imagePaths.thumbnailObjectKey(fixture.key)
      );
    }
    await database.pool.query(
      "DELETE FROM background_job WHERE target_id=ANY($1::text[])",
      [fixtures.map((fixture) => fixture.id)]
    );
    await database.pool.query(
      "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
      [fixtures.map((fixture) => fixture.id)]
    );
  };

  const migrationConcurrency = storageMigrationAdmission
    .IMAGE_TRANSFER_CONCURRENCY;
  const listAbortFixtures = [];
  for (let index = 0; index < migrationConcurrency + 2; index += 1) {
    listAbortFixtures.push(await addAbortMigrationImage(randomUUID(), "local"));
  }
  const listAbortKeys = new Set(
    listAbortFixtures.map((fixture) => fixture.key)
  );
  const originalListAbortOpenRead = localAccess.driver.openRead;
  let listAbortReadCount = 0;
  let releaseListAbortReads!: () => void;
  let markListAbortReadsStarted!: () => void;
  const listAbortReadGate = new Promise<void>((resolve) => {
    releaseListAbortReads = resolve;
  });
  const listAbortReadsStarted = new Promise<void>((resolve) => {
    markListAbortReadsStarted = resolve;
  });
  const expectedListAbortReads = Math.min(
    migrationConcurrency,
    listAbortFixtures.length
  );
  localAccess.driver.openRead = async function (...args) {
    if (args[0] === "full" && listAbortKeys.has(args[1])) {
      listAbortReadCount += 1;
      if (listAbortReadCount === expectedListAbortReads) {
        markListAbortReadsStarted();
      }
      await listAbortReadGate;
    }
    return originalListAbortOpenRead.apply(this, args);
  };
  const listAbortController = new AbortController();
  const listAbortReason = new Error("injected migration list abort");
  const interruptedListMigration = imageStorageMigration.migrateSelectedImagesToStorageBackend(
    listAbortFixtures.map((fixture) => fixture.id),
    "local-migration",
    { signal: listAbortController.signal }
  );
  try {
    await waitForAbortReads(
      listAbortReadsStarted,
      "image migration list"
    );
    listAbortController.abort(listAbortReason);
    releaseListAbortReads();
    await assert.rejects(
      interruptedListMigration,
      (error) => error === listAbortReason
    );
  } finally {
    releaseListAbortReads();
    await interruptedListMigration.catch(() => undefined);
    localAccess.driver.openRead = originalListAbortOpenRead;
  }
  assert.equal(listAbortReadCount, expectedListAbortReads);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=ANY($1::uuid[]) "
        + "AND storage_slug='local'",
      [listAbortFixtures.map((fixture) => fixture.id)]
    )).rows[0]?.count),
    listAbortFixtures.length,
    "请求中止时当前并发片收口，后续图片不得启动或提交迁移"
  );
  await removeAbortMigrationImages(listAbortFixtures);

  const backendAbortSource = "local-abort-source";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ($1, 'Local abort source', 'local', true)",
    [backendAbortSource]
  );
  registry.invalidateStorageBackendRegistry();
  const backendAbortFixtures = [];
  for (let index = 0; index < 3; index += 1) {
    backendAbortFixtures.push(await addAbortMigrationImage(
      randomUUID(),
      backendAbortSource
    ));
  }
  const backendAbortKeys = new Set(
    backendAbortFixtures.map((fixture) => fixture.key)
  );
  const originalBackendAbortOpenRead = localAccess.driver.openRead;
  let backendAbortReadCount = 0;
  let releaseBackendAbortRead!: () => void;
  let markBackendAbortReadStarted!: () => void;
  const backendAbortReadGate = new Promise<void>((resolve) => {
    releaseBackendAbortRead = resolve;
  });
  const backendAbortReadStarted = new Promise<void>((resolve) => {
    markBackendAbortReadStarted = resolve;
  });
  localAccess.driver.openRead = async function (...args) {
    if (args[0] === "full" && backendAbortKeys.has(args[1])) {
      backendAbortReadCount += 1;
      markBackendAbortReadStarted();
      await backendAbortReadGate;
    }
    return originalBackendAbortOpenRead.apply(this, args);
  };
  const backendAbortController = new AbortController();
  const backendAbortReason = new Error("injected backend migration abort");
  const interruptedBackendMigration = backendMigration.migrateStorageBackendImages(
    backendAbortSource,
    "local-migration",
    { signal: backendAbortController.signal }
  );
  try {
    await waitForAbortReads(
      backendAbortReadStarted,
      "backend migration"
    );
    backendAbortController.abort(backendAbortReason);
    releaseBackendAbortRead();
    await assert.rejects(
      interruptedBackendMigration,
      (error) => error === backendAbortReason
    );
  } finally {
    releaseBackendAbortRead();
    await interruptedBackendMigration.catch(() => undefined);
    localAccess.driver.openRead = originalBackendAbortOpenRead;
  }
  assert.equal(
    backendAbortReadCount,
    Math.min(migrationConcurrency, backendAbortFixtures.length)
  );
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=ANY($1::uuid[]) "
        + "AND storage_slug=$2",
      [
        backendAbortFixtures.map((fixture) => fixture.id),
        backendAbortSource
      ]
    )).rows[0]?.count),
    backendAbortFixtures.length,
    "整后端请求中止后只收口已进入固定准入片的项目，且不得提交当前位置"
  );
  await removeAbortMigrationImages(backendAbortFixtures);
  await database.pool.query(
    "DELETE FROM storage_backend WHERE slug=$1",
    [backendAbortSource]
  );
  registry.invalidateStorageBackendRegistry();

  const responseLossId = randomUUID();
  const responseLossBody = Buffer.from("migration-response-loss");
  const responseLossKey = await addMigrationImage(
    responseLossId,
    "local",
    responseLossBody
  );
  const verifyStorageMigrationResponseLoss = async () => {
  let armed = false;
  let responseLost = false;
  const restore = interceptSqlQueries(database.pool, async (sql, _values, query) => {
    const result = await query();
    if (sql.includes("FROM ready_image_revision")) armed = true;
    return result;
  });
  try {
    assert.equal(
      await withCommitFault(database.pool, "committed", () => storageMigration.migrateImageToStorageBackend(
        {
          id: responseLossId,
          object_key: responseLossKey,
          ext: "webp",
          storage_slug: "local",
          md5: createHash("md5").update(responseLossBody).digest("hex"),
          image_size: responseLossBody.byteLength,
          thumbnail_size: responseLossBody.byteLength
        },
        "local-migration"
      ), async () => undefined, () => {
        if (!armed || responseLost) return false;
        responseLost = true;
        return true;
      }),
      "migrated"
    );
  } finally {
    restore();
  }
  assert.equal(responseLost, true);
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [responseLossId]
    )).rows[0]?.storage_slug,
    "local-migration"
  );
  };

  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ('local-copy', 'Local copy', 'local', true)"
  );
  registry.invalidateStorageBackendRegistry();
  await verifyStorageMigrationResponseLoss();
});
