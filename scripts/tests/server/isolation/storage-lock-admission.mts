import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { removeDriverObject } from "./storage-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const locks = await import("../../../../packages/server/src/storage/maintenance-lock.ts");
const cleanup = await import("../../../../packages/server/src/storage/cleanup/service.ts");
const registry = await import("../../../../packages/server/src/storage/backends/registry.ts");
const objectAccess = await import("../../../../packages/server/src/storage/objects/access.ts");
  const detachedImage = randomUUID();
  const controller = new AbortController();
  await database.runWithAdvisoryLockAcquisitionSignal(controller.signal, () => (
    locks.withStorageLocationReadLock(async (lockSignal) => {
      const captured = await cleanup.captureMoveCleanupObjects([
        {
          prefix: "thumbs",
          key: detachedImage + ".webp",
          backend: "local"
        }
      ]);
      controller.abort(new Error("injected parent abort"));
      assert.equal(
        lockSignal.aborted,
        false,
        "调度取消不得污染已取得 advisory lock 的连接信号"
      );
      await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
        detachedImage,
        captured,
        "fault_injected_after_publish"
      );
    })
  ));
  const receipt = await database.pool.query(
    "SELECT payload FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [detachedImage]
  );
  assert.equal(receipt.rowCount, 1);
  assert.equal(
    typeof receipt.rows[0]?.payload?.objects?.[0]?.namespace_identity,
    "string"
  );

  const lockLossReason = new Error("injected advisory connection loss");
  await assert.rejects(
    () => locks.withStorageLocationReadLock(async (lockSignal, lockClient) => {
      lockClient.emit("error", lockLossReason);
      lockSignal.throwIfAborted();
    }),
    (error: unknown) => error instanceof Error && "code" in error
      && error.code === "advisory_lock_lost" && error.cause === lockLossReason
  );

  const local = await registry.getStorageBackend("local");
  const localAccess = registry.resolveStorageAccessForConfig(local);

  const cleanupAdmissionPrefix = "cleanup-admission/" + randomUUID();
  const admittedRemovalKey = cleanupAdmissionPrefix + ".active.webp";
  const queuedRemovalKey = cleanupAdmissionPrefix + ".queued.webp";
  await localAccess.driver.writeBuffer(
    "full",
    admittedRemovalKey,
    Buffer.from("active-cleanup-admission"),
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "full",
    queuedRemovalKey,
    Buffer.from("queued-cleanup-admission"),
    "image/webp"
  );
  const originalAdmissionRemove = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let releaseAdmittedRemoval!: () => void;
  const admittedRemovalReleased = new Promise<void>((resolve) => {
    releaseAdmittedRemoval = resolve;
  });
  let markAdmittedRemovalStarted!: () => void;
  const admittedRemovalStarted = new Promise<void>((resolve) => {
    markAdmittedRemovalStarted = resolve;
  });
  let queuedRemovalStarted = false;
  localAccess.driver.removeObjects = async (objects, options) => {
    if (objects.some((object) => object.key === admittedRemovalKey)) {
      markAdmittedRemovalStarted();
      await admittedRemovalReleased;
    }
    if (objects.some((object) => object.key === queuedRemovalKey)) {
      queuedRemovalStarted = true;
    }
    return originalAdmissionRemove(objects, options);
  };
  const queuedAdmission = new AbortController();
  const queuedAdmissionReason = new Error("cancel queued cleanup admission");
  let activeRemovalOutcome;
  let queuedRemovalOutcome;
  try {
    const activeRemoval = objectAccess.removeStorageObjectsAndConfirm([
      {
        prefix: "full",
        key: admittedRemovalKey,
        storageSlug: "local"
      }
    ], {}, new AbortController().signal).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );
    await admittedRemovalStarted;
    const queuedRemoval = objectAccess.removeStorageObjectsAndConfirm([
      {
        prefix: "full",
        key: queuedRemovalKey,
        storageSlug: "local"
      }
    ], {}, queuedAdmission.signal).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    queuedAdmission.abort(queuedAdmissionReason);
    releaseAdmittedRemoval();
    [activeRemovalOutcome, queuedRemovalOutcome] = await Promise.all([
      activeRemoval,
      queuedRemoval
    ]);
  } finally {
    releaseAdmittedRemoval();
    localAccess.driver.removeObjects = originalAdmissionRemove;
  }
  assert.equal(activeRemovalOutcome.status, "fulfilled");
  assert.equal(queuedRemovalOutcome.status, "rejected");
  assert.equal(queuedRemovalOutcome.reason, queuedAdmissionReason);
  assert.equal(queuedRemovalStarted, false);
  assert.equal(
    await localAccess.driver.exists("full", admittedRemovalKey),
    false
  );
  assert.equal(
    await localAccess.driver.exists("full", queuedRemovalKey),
    true,
    "取消的中央准入等待不得启动后续 driver 删除"
  );
  await removeDriverObject(localAccess.driver, "full", queuedRemovalKey);

});
