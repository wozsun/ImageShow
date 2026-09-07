import assert from "node:assert/strict";
import sharp from "sharp";
import { createMaintenanceFixture } from "./storage-maintenance-fixture.mts";
import { interceptSqlQueries } from "./database-faults.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { access, createImage } = await createMaintenanceFixture(runtime);
  const { repairStorageThumbnail } = await import("../../../../packages/server/src/checks/storage-thumbnail-repair.ts");
  const { maintainStorageAndPurgeTasks } = await import("../../../../packages/server/src/checks/storage-maintenance.ts");
  const { checkStorage } = await import("../../../../packages/server/src/checks/storage-check.ts");
  const cleanup = await import("../../../../packages/server/src/storage/cleanup/service.ts");
  const signal = new AbortController().signal;
  for (const entry of [
    { name: "source missing", source: false, confirmedSize: 0, thumbnail: undefined, outcome: "skipped" },
    { name: "confirmed existing", source: true, confirmedSize: 7, thumbnail: Buffer.from("trusted"), outcome: "skipped" },
    { name: "confirmed missing", source: true, confirmedSize: 7, thumbnail: undefined, outcome: "repaired" },
    { name: "unconfirmed missing", source: true, confirmedSize: 0, thumbnail: undefined, outcome: "repaired" },
    { name: "unconfirmed existing", source: true, confirmedSize: 0, thumbnail: Buffer.from("unconfirmed"), outcome: "repaired" }
  ]) {
    const image = await createImage(entry);
    assert.equal((await repairStorageThumbnail(image.id, signal)).outcome, entry.outcome, entry.name);
    if (entry.outcome === "repaired") {
      const actual = await access.driver.readBuffer("thumbs", image.thumb);
      assert.ok(actual.length > 0);
      assert.equal(Number((await image.row()).thumbnail_size), actual.length);
      if (entry.thumbnail) assert.notDeepEqual(actual, entry.thumbnail);
    } else {
      assert.equal(Number((await image.row()).thumbnail_size), entry.confirmedSize);
      if (entry.thumbnail) assert.deepEqual(await access.driver.readBuffer("thumbs", image.thumb), entry.thumbnail);
    }
  }
  for (const race of ["restored", "moved"] as const) {
    const image = await createImage();
    const originalRead = access.driver.readBuffer.bind(access.driver);
    const winner = Buffer.from("concurrent repair winner");
    let injected = false;
    access.driver.readBuffer = async (...args) => {
      const body = await originalRead(...args);
      if (args[0] === "full" && args[1] === image.key && !injected) {
        injected = true;
        if (race === "restored") {
          await access.driver.writeBuffer("thumbs", image.thumb, winner, "image/webp");
          await runtime.databasePools.pool.query("UPDATE metadata SET thumbnail_size=$2 WHERE id=$1", [image.id, winner.length]);
        } else await runtime.databasePools.pool.query("UPDATE metadata SET object_key=$2 WHERE id=$1", [image.id, image.key + ".moved"]);
      }
      return body;
    };
    try {
      assert.equal((await repairStorageThumbnail(image.id, signal)).outcome, "skipped");
      assert.equal(injected, true);
      if (race === "restored") assert.deepEqual(await originalRead("thumbs", image.thumb), winner);
      else assert.equal(await access.driver.exists("thumbs", image.thumb), false);
    } finally {
      access.driver.readBuffer = originalRead;
      await runtime.databasePools.pool.query("UPDATE metadata SET object_key=$2 WHERE id=$1", [image.id, image.key]);
    }
  }
  const responseLost = await createImage();
  const originalWrite = access.driver.writeBuffer.bind(access.driver);
  let lostResponse = false;
  access.driver.writeBuffer = async (...args) => {
    await originalWrite(...args);
    if (args[0] === "thumbs" && args[1] === responseLost.thumb) { lostResponse = true; throw new Error("write response lost"); }
  };
  try {
    assert.equal((await repairStorageThumbnail(responseLost.id, signal)).outcome, "repaired");
    assert.equal(lostResponse, true);
    assert.equal(Number((await responseLost.row()).thumbnail_size), (await access.driver.readBuffer("thumbs", responseLost.thumb)).length);
  } finally { access.driver.writeBuffer = originalWrite; }
  const cancelled = await createImage();
  const cancellation = new Error("cancel thumbnail before generation");
  const cancelRepair = new AbortController();
  const originalExists = access.driver.exists.bind(access.driver);
  let cancellationInjected = false;
  access.driver.exists = async (...args) => {
    const exists = await originalExists(...args);
    if (args[0] === "full" && args[1] === cancelled.key) {
      cancellationInjected = true;
      cancelRepair.abort(cancellation);
    }
    return exists;
  };
  try {
    await assert.rejects(repairStorageThumbnail(cancelled.id, cancelRepair.signal), error => error === cancellation);
    assert.equal(cancellationInjected, true);
  } finally { access.driver.exists = originalExists; }
  assert.equal(await access.driver.exists("thumbs", cancelled.thumb), false);
  assert.equal(Number((await cancelled.row()).thumbnail_size), 0);

  const protectedBody = Buffer.from("pending cleanup lease");
  const protectedImage = await createImage({ thumbnail: protectedBody });
  const captured = await cleanup.captureMoveCleanupObjects([{ prefix: "thumbs", key: protectedImage.thumb, backend: "local" }]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(protectedImage.id, captured, "thumbnail-test-lease");
  assert.equal((await repairStorageThumbnail(protectedImage.id, signal)).outcome, "failed");
  assert.deepEqual(await access.driver.readBuffer("thumbs", protectedImage.thumb), protectedBody);
  assert.equal(Number((await protectedImage.row()).thumbnail_size), 0);
  assert.equal((await runtime.databasePools.pool.query("SELECT id FROM background_job WHERE target_id=$1", [protectedImage.id])).rowCount, 1);

  const failedImage = await createImage();
  let failedDatabase = false;
  let failedCleanup = false;
  const restoreSql = interceptSqlQueries(runtime.databasePools.pool, async (sql, values, query) => {
    if (/UPDATE metadata\s+SET thumbnail_size/i.test(sql) && Array.isArray(values) && values[0] === failedImage.id && Number(values[1]) > 0) {
      failedDatabase = true; throw new Error("thumbnail database confirmation failed");
    }
    return query();
  });
  const originalRemove = access.driver.removeObjects.bind(access.driver);
  access.driver.removeObjects = async (objects, options) => {
    if (objects.some(object => object.key === failedImage.thumb)) { failedCleanup = true; throw new Error("thumbnail cleanup failed"); }
    return originalRemove(objects, options);
  };
  try {
    const result = (await maintainStorageAndPurgeTasks()).storage;
    assert.equal(result.items.find(item => item.image_id === failedImage.id)?.outcome, "failed");
    assert.equal(failedDatabase, true);
    assert.equal(failedCleanup, true);
    assert.equal(Number((await failedImage.row()).thumbnail_size), 0);
    assert.equal(await access.driver.exists("thumbs", failedImage.thumb), true);
    const check = await checkStorage();
    assert.ok(check.pending_thumbnail_repairs.some(item => item.id === failedImage.id));
  } finally { restoreSql(); access.driver.removeObjects = originalRemove; }
  assert.equal((await repairStorageThumbnail(failedImage.id, signal)).outcome, "repaired");
  const bytes = await access.driver.readBuffer("thumbs", failedImage.thumb);
  assert.equal((await sharp(bytes).metadata()).format, "webp");
  assert.equal(Number((await failedImage.row()).thumbnail_size), bytes.length);
});
