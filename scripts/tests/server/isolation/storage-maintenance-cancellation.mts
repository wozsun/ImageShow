import assert from "node:assert/strict";
import { createS3HttpFixture } from "../../support/s3-http-fixture.ts";
import { randomUUID } from "node:crypto";
import type { ImageStorageMigrationRecord } from "../../../../packages/server/src/images/storage-location/image-migration.ts";
import {
  createMaintenanceFixture,
  settleWithin,
  waitForStorageLockWait
} from "./storage-maintenance-fixture.mts";
import { removeDriverObject } from "./storage-fixture.mts";
import { neverAbortedSignal } from "../../../../packages/server/src/core/abort.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { access, body, createImage } = await createMaintenanceFixture(runtime);
  const { pool } = runtime.databasePools;
  const { maintainStorageAndPurgeTasks } =
    await import("../../../../packages/server/src/checks/storage-maintenance.ts");
  const { checkStorage } = await import("../../../../packages/server/src/checks/storage-check.ts");
  const locks = await import("../../../../packages/server/src/storage/maintenance-lock.ts");
  const migration =
    await import("../../../../packages/server/src/images/storage-location/image-migration.ts");
  const incompleteKey = "orphan/incomplete.webp";
  await access.driver.writeBuffer(
    "large",
    incompleteKey,
    Buffer.from("retain incomplete"),
    "image/webp"
  );
  const originalList = access.driver.listKeys.bind(access.driver);
  access.driver.listKeys = (prefix, options) =>
    prefix === "large"
      ? (async function* () {
          yield [incompleteKey];
          return { complete: false, count: 1, reason: "max_keys" as const };
        })()
      : originalList(prefix, options);
  try {
    assert.ok(
      (await checkStorage(neverAbortedSignal)).incomplete_listings
        .some((item) => item.prefix === "large")
    );
    assert.ok((await maintainStorageAndPurgeTasks(neverAbortedSignal)).storage.failed > 0);
    assert.equal(await access.driver.exists("large", incompleteKey), true);
  } finally {
    access.driver.listKeys = originalList;
    await removeDriverObject(access.driver, "large", incompleteKey);
  }

  {
    const blocker = await pool.connect();
    const stop = new AbortController();
    const reason = new Error("cancel maintenance lock wait");
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("SELECT pg_advisory_lock_shared(hashtext($1))", [
        "imageshow:storage-location"
      ]);
      pending = maintainStorageAndPurgeTasks(stop.signal);
      void pending.catch(() => undefined);
      await waitForStorageLockWait(pool, false);
      stop.abort(reason);
      await assert.rejects(settleWithin(pending), (error) => error === reason);
    } finally {
      stop.abort(reason);
      await blocker.query("SELECT pg_advisory_unlock_shared(hashtext($1))", [
        "imageshow:storage-location"
      ]);
      blocker.release();
      await Promise.allSettled(pending ? [pending] : []);
    }
  }
  assert.equal(await locks.withStorageLocationWriteLock(async () => true), true);

  await pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) VALUES ('local-maintenance','Maintenance target','local',true)"
  );
  runtime.storageRegistry.invalidateStorageBackendRegistry();
  const replica = await createS3HttpFixture();
  await pool.query("INSERT INTO storage_backend(slug,display_name,type,config) VALUES ('replica','Replica','s3',$1::jsonb)", [JSON.stringify({...replica.settings,capabilities:{content_md5:true}})]);
  runtime.storageRegistry.invalidateStorageBackendRegistry();
  const replicaAccess = await runtime.storageRegistry.resolveStorageAccess("replica");
  try {
  // Repairs finish before orphan removal; cancellation drains the current phase before releasing the position lock.
  for (const firstFinished of ["repair", "removal"] as const) {
    const image = await createImage();
    await replicaAccess.driver.writeBuffer("small", image.thumb, body, "image/webp");
    const orphanKeys = Array.from({ length: 4 }, () => "orphan/cancel-" + randomUUID() + ".webp");
    for (const key of orphanKeys)
      await access.driver.writeBuffer("large", key, Buffer.from("orphan"), "image/webp");
    const repairStarted = Promise.withResolvers<void>();
    const removalStarted = Promise.withResolvers<void>();
    const repairGate = Promise.withResolvers<void>();
    const removalGate = Promise.withResolvers<void>();
    const repairFinished = Promise.withResolvers<void>();
    const removalFinished = Promise.withResolvers<void>();
    const originalWrite = access.driver.writeStream.bind(access.driver);
    const originalRemove = access.driver.removeObjects.bind(access.driver);
    const startedKeys: string[] = [];
    access.driver.writeStream = async (...args) => {
      await originalWrite(...args);
      if (args[0] === "small" && args[1] === image.thumb) {
        repairStarted.resolve();
        if (firstFinished === "repair") await repairGate.promise;
        assert.equal(args[5]?.signal?.aborted, false);
        repairFinished.resolve();
      }
    };
    access.driver.removeObjects = async (objects, options) => {
      const matches = objects.filter((object) => orphanKeys.includes(object.key));
      const result = await originalRemove(objects, options);
      if (matches.length) {
        startedKeys.push(...matches.map((object) => object.key));
        removalStarted.resolve();
        if (firstFinished === "removal") await removalGate.promise;
        assert.equal(options?.signal?.aborted, false);
        removalFinished.resolve();
      }
      return result;
    };
    const stop = new AbortController();
    const reason = new Error("cancel mixed maintenance after " + firstFinished);
    const pending = maintainStorageAndPurgeTasks(stop.signal);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    let migrationPending: Promise<unknown> | undefined;
    try {
      await settleWithin(
        Promise.race([
          firstFinished === "repair" ? repairStarted.promise : removalStarted.promise,
          pending.then(() => assert.fail("controlled maintenance phase must start"))
        ])
      );
      const source = (
        await pool.query<ImageStorageMigrationRecord>(
          "SELECT * FROM metadata WHERE id=$1",
          [image.id]
        )
      ).rows[0]!;
      migrationPending = migration.migrateImageToStorageBackend(source, "local-maintenance", {
        signal: neverAbortedSignal
      });
      void migrationPending.catch(() => undefined);
      await waitForStorageLockWait(pool, true);
      assert.equal((await image.row()).storage_slug, "local");
      stop.abort(reason);
      await waitForStorageLockWait(pool, true);
      assert.equal(settled, false, "在途阶段仍持有维护锁");
      assert.equal((await image.row()).storage_slug, "local");
      repairGate.resolve();
      removalGate.resolve();
      await assert.rejects(settleWithin(pending), (error) => error === reason);
      assert.equal(await settleWithin(migrationPending), "migrated");
      assert.equal((await image.row()).storage_slug, "local-maintenance");
      assert.equal(startedKeys.length, firstFinished === "repair" ? 0 : 1);
      for (const key of orphanKeys)
        assert.equal(await access.driver.exists("large", key), !startedKeys.includes(key));
    } finally {
      stop.abort(reason);
      repairGate.resolve();
      removalGate.resolve();
      await Promise.allSettled([pending, ...(migrationPending ? [migrationPending] : [])]);
      access.driver.writeStream = originalWrite;
      access.driver.removeObjects = originalRemove;
      for (const key of orphanKeys) await removeDriverObject(access.driver, "large", key);
    }
  }
  } finally { await replica.close(); }
});
