import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { removeDriverObject } from "./storage-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const registry = await import("../../../../packages/server/src/storage/backends/registry.ts");
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const imageUpdate = await import("../../../../packages/server/src/images/image-update.ts");
const localAccess = await registry.resolveStorageAccess("local");
const readReadyRevision = async () => BigInt(String((
  await database.pool.query(
    "SELECT revision::text FROM ready_image_revision WHERE singleton=1"
  )
).rows[0].revision));
  const classificationRollbackId = randomUUID();
  const classificationRollbackSource = imagePaths.storageObjectKey(classificationRollbackId, "webp");
  const classificationRollbackBody = Buffer.from(
    "atomic-classification-rollback"
  );
  const classificationRollbackMd5 = createHash("md5")
    .update(classificationRollbackBody)
    .digest("hex");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size, title) VALUES "
      + "($1, 'integration-admin', 'local', $2, 'pc', 'dark', NULL, 'webp', $3, $4, 'before')",
    [
      classificationRollbackId,
      classificationRollbackSource,
      classificationRollbackMd5,
      classificationRollbackBody.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    classificationRollbackSource,
    classificationRollbackBody,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationRollbackSource),
    classificationRollbackBody,
    "image/webp"
  );
  await database.pool.query(`
    CREATE OR REPLACE FUNCTION imageshow_test_reject_classification_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'forced classification transaction failure';
    END;
    $function$;
    CREATE TRIGGER imageshow_test_reject_classification_update
      BEFORE UPDATE ON metadata
      FOR EACH ROW EXECUTE FUNCTION imageshow_test_reject_classification_update();
  `);
  const revisionBeforeClassificationRollback = await readReadyRevision();
  let failedClassificationUpdate;
  try {
    failedClassificationUpdate = await imageUpdate.updateImages([{
      id: classificationRollbackId,
      brightness: "light",
      title: "must-roll-back",
      tags: ["classification-rollback-tag"]
    }]);
  } finally {
    await database.pool.query(`
      DROP TRIGGER imageshow_test_reject_classification_update ON metadata;
      DROP FUNCTION imageshow_test_reject_classification_update();
    `);
  }
  assert.equal(failedClassificationUpdate.updated, 0);
  assert.equal(failedClassificationUpdate.failed, 1);
  assert.equal(await readReadyRevision(), revisionBeforeClassificationRollback);
  assert.deepEqual((await database.pool.query(
    "SELECT object_key, brightness, title FROM metadata WHERE id=$1",
    [classificationRollbackId]
  )).rows[0], {
    object_key: classificationRollbackSource,
    brightness: "dark",
    title: "before"
  });
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM tag "
      + "WHERE slug='classification-rollback-tag'"
  )).rows[0].count), 0);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*)::int AS count FROM background_job "
        + "WHERE target_id=$1 AND type='move.cleanup'",
      [classificationRollbackId]
    )).rows[0].count),
    0,
    "元数据事务失败不得生成存储补偿任务"
  );
  assert.equal(
    await localAccess.driver.exists("full", classificationRollbackSource),
    true
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [classificationRollbackId]
  );
  await removeDriverObject(localAccess.driver, "full", classificationRollbackSource);
  await removeDriverObject(
    localAccess.driver,
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationRollbackSource)
  );

  const classificationId = randomUUID();
  const classificationSourceKey = imagePaths.storageObjectKey(classificationId, "webp");
  const classificationBody = Buffer.from("classification-metadata-only");
  const classificationMd5 = createHash("md5")
    .update(classificationBody)
    .digest("hex");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, image_size, thumbnail_size, status) VALUES "
      + "($1, 'integration-admin', 'local', $2, 'pc', 'dark', NULL, 'webp', $3, $4, $4, "
      + "'ready')",
    [
      classificationId,
      classificationSourceKey,
      classificationMd5,
      classificationBody.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    classificationSourceKey,
    classificationBody,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationSourceKey),
    classificationBody,
    "image/webp"
  );
  assert.deepEqual(await imageUpdate.updateImages([{
    id: classificationId,
    brightness: "light"
  }]), {
    updated: 1,
    failed: 0,
    results: [{ id: classificationId, status: "updated" }]
  });
  assert.deepEqual((await database.pool.query(
    "SELECT object_key, brightness FROM metadata WHERE id=$1",
    [classificationId]
  )).rows[0], {
    object_key: classificationSourceKey,
    brightness: "light"
  });
  assert.equal(
    await localAccess.driver.exists("full", classificationSourceKey),
    true,
    "分类字段变化只修改 PostgreSQL 元数据"
  );
  assert.equal(
    await localAccess.driver.exists(
      "thumbs",
      imagePaths.thumbnailObjectKey(classificationSourceKey)
    ),
    true
  );
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*)::int AS count FROM background_job "
        + "WHERE target_id=$1 AND type='move.cleanup'",
      [classificationId]
    )).rows[0].count),
    0
  );
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [classificationId]);
  await removeDriverObject(localAccess.driver, "full", classificationSourceKey);
  await removeDriverObject(
    localAccess.driver,
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationSourceKey)
  );

  const classificationMissingThumbId = randomUUID();
  const classificationMissingThumbSource = imagePaths.storageObjectKey(classificationMissingThumbId, "webp");
  const classificationMissingThumbBody = Buffer.from(
    "classification-without-thumbnail"
  );
  const classificationMissingThumbMd5 = createHash("md5")
    .update(classificationMissingThumbBody)
    .digest("hex");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES "
      + "($1, 'integration-admin', 'local', $2, 'pc', 'dark', NULL, 'webp', $3, 0)",
    [
      classificationMissingThumbId,
      classificationMissingThumbSource,
      classificationMissingThumbMd5
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    classificationMissingThumbSource,
    classificationMissingThumbBody,
    "image/webp"
  );
  assert.equal((await imageUpdate.updateImages([{
    id: classificationMissingThumbId,
    brightness: "light"
  }])).failed, 0);
  assert.deepEqual((await database.pool.query(
    "SELECT object_key, brightness FROM metadata WHERE id=$1",
    [classificationMissingThumbId]
  )).rows[0], {
    object_key: classificationMissingThumbSource,
    brightness: "light"
  });
  assert.equal(
    await localAccess.driver.exists("full", classificationMissingThumbSource),
    true,
    "明确的分类修改不应依赖缩略图或创建新存储位置"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [classificationMissingThumbId]
  );
  await removeDriverObject(localAccess.driver, "full", classificationMissingThumbSource);

});
