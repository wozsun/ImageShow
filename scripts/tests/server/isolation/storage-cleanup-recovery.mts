import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { controlledStorageDriver, removeDriverObject } from "./storage-fixture.mts";
import type { StorageAccess } from "../../../../packages/server/src/storage/objects/transfer.ts";
import { interceptSqlQueries } from "./database-faults.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const { mergeS3Settings } = await import("../../../../packages/server/src/storage/backends/config.ts");
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const cleanup = await import("../../../../packages/server/src/storage/cleanup/service.ts");
const cleanupJob = await import("../../../../packages/server/src/storage/cleanup/job.ts");
const jobs = await import("../../../../packages/server/src/jobs/repository.ts");
const registry = await import("../../../../packages/server/src/storage/backends/registry.ts");
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const objectTransfer = await import("../../../../packages/server/src/storage/objects/transfer.ts");
const localAccess = await registry.resolveStorageAccess("local");
  const foregroundImage = randomUUID();
  const foregroundObjectKey = imagePaths.storageObjectKey(randomUUID(), "webp");
  const foregroundNextKey = imagePaths.storageObjectKey(foregroundImage, "webp");
  const foregroundFull = Buffer.from("move-cleanup-owned-full");
  const foregroundThumb = Buffer.from("move-cleanup-owned-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES ($1, 'integration-admin', 'local', $2, 'pc', "
      + "'light', NULL, 'webp', $3, $4)",
    [
      foregroundImage,
      foregroundNextKey,
      createHash("md5").update(foregroundFull).digest("hex"),
      foregroundThumb.byteLength
    ]
  );
  for (const key of [foregroundObjectKey, foregroundNextKey]) {
    await localAccess.driver.writeBuffer("full", key, foregroundFull, "image/webp");
    await localAccess.driver.writeBuffer(
      "thumbs",
      imagePaths.thumbnailObjectKey(key),
      foregroundThumb,
      "image/webp"
    );
  }
  const foregroundCleanupObjects = await cleanup.captureMoveCleanupObjects([
    { prefix: "full", key: foregroundObjectKey, backend: "local" },
    {
      prefix: "thumbs",
      key: imagePaths.thumbnailObjectKey(foregroundObjectKey),
      backend: "local"
    }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    foregroundImage,
    foregroundCleanupObjects,
    "test_cleanup_re_adoption"
  );
  const foregroundCleanupReceipt = (await database.pool.query(
    "SELECT * FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [foregroundImage]
  )).rows[0];
  assert.deepEqual(
    Object.keys(foregroundCleanupReceipt.payload).sort(),
    ["objects", "reason", "retain_exhausted"]
  );
  assert.ok(foregroundCleanupReceipt.payload.objects.every((object: Record<string, unknown>) => (
    Object.keys(object).sort().join(",")
      === "backend,key,namespace_identity,prefix"
  )));
  await database.pool.query(
    "UPDATE metadata SET object_key=$2, brightness='dark' WHERE id=$1",
    [foregroundImage, foregroundObjectKey]
  );
  const adoptedToken = randomUUID();
  const adoptedCleanupJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [foregroundCleanupReceipt.id, adoptedToken]
  )).rows[0];
  await cleanupJob.handleMoveCleanupJob(
    adoptedCleanupJob,
    new AbortController().signal
  );
  assert.equal(await jobs.markBackgroundJobSucceeded(adoptedCleanupJob), true);
  assert.equal(
    await localAccess.driver.exists("full", foregroundObjectKey),
    true,
    "删除边界重新采用的原图必须保留"
  );
  assert.equal(
    await localAccess.driver.exists(
      "thumbs",
      imagePaths.thumbnailObjectKey(foregroundObjectKey)
    ),
    true,
    "删除边界重新采用的缩略图必须保留"
  );

  await database.pool.query(
    "UPDATE metadata SET object_key=$2, brightness='light' WHERE id=$1",
    [foregroundImage, foregroundNextKey]
  );
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    foregroundImage,
    foregroundCleanupObjects,
    "test_cleanup_after_re_adoption"
  );
  const unreferencedToken = randomUUID();
  const unreferencedCleanupJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [foregroundCleanupReceipt.id, unreferencedToken]
  )).rows[0];
  await cleanupJob.handleMoveCleanupJob(
    unreferencedCleanupJob,
    new AbortController().signal
  );
  assert.equal(
    await jobs.markBackgroundJobSucceeded(unreferencedCleanupJob),
    true
  );
  assert.equal(await localAccess.driver.exists("full", foregroundObjectKey), false);
  assert.equal(
    await localAccess.driver.exists(
      "thumbs",
      imagePaths.thumbnailObjectKey(foregroundObjectKey)
    ),
    false
  );
  assert.equal(await localAccess.driver.exists("full", foregroundNextKey), true);

  const uncertainCleanupImage = randomUUID();
  const uncertainCleanupKey = imagePaths.storageObjectKey(
    uncertainCleanupImage,
    "webp"
  );
  await localAccess.driver.writeBuffer(
    "full",
    uncertainCleanupKey,
    Buffer.from("move-cleanup-delete-response-loss"),
    "image/webp"
  );
  const uncertainCleanupObjects = await cleanup.captureMoveCleanupObjects([
    { prefix: "full", key: uncertainCleanupKey, backend: "local" }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    uncertainCleanupImage,
    uncertainCleanupObjects,
    "test_cleanup_delete_response_loss"
  );
  const uncertainReceipt = (await database.pool.query(
    "SELECT * FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [uncertainCleanupImage]
  )).rows[0];
  const uncertainToken = randomUUID();
  const uncertainJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [uncertainReceipt.id, uncertainToken]
  )).rows[0];
  const originalCleanupRemoveObjects = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let loseCleanupDeleteResponse = true;
  localAccess.driver.removeObjects = async (objects, options) => {
    const results = await originalCleanupRemoveObjects(objects, options);
    if (
      loseCleanupDeleteResponse
      && objects.some((object) => (
        object.prefix === "full" && object.key === uncertainCleanupKey
      ))
    ) {
      loseCleanupDeleteResponse = false;
      throw new Error("injected move cleanup delete response loss");
    }
    return results;
  };
  try {
    await assert.rejects(() => cleanupJob.handleMoveCleanupJob(
      uncertainJob,
      new AbortController().signal
    ));
  } finally {
    localAccess.driver.removeObjects = originalCleanupRemoveObjects;
  }
  assert.equal(
    await localAccess.driver.exists("full", uncertainCleanupKey),
    false,
    "删除响应丢失后对象可以已经不存在"
  );
  await database.pool.query(
    "UPDATE background_job SET status='pending', execution_token=NULL WHERE id=$1",
    [uncertainReceipt.id]
  );
  const retryToken = randomUUID();
  const retryJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [uncertainReceipt.id, retryToken]
  )).rows[0];
  await cleanupJob.handleMoveCleanupJob(retryJob, new AbortController().signal);
  assert.equal(await jobs.markBackgroundJobSucceeded(retryJob), true);

  const latePublishImage = randomUUID();
  const latePublishKey = imagePaths.storageObjectKey(latePublishImage, "webp");
  const latePublishBody = Buffer.from("late-published-after-client-rejection");
  const latePublishObjects = await cleanup.captureMoveCleanupObjects([{
    prefix: "full",
    key: latePublishKey,
    backend: "local"
  }]);
  const confirmAbsentAfter = new Date(Date.now() + 200);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    latePublishImage,
    latePublishObjects,
    "test_cleanup_late_publish",
    { confirmAbsentAfter }
  );
  const latePublishToken = randomUUID();
  const latePublishJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [latePublishImage, latePublishToken]
  )).rows[0];
  assert.equal(
    latePublishJob.payload.confirm_absent_after,
    confirmAbsentAfter.toISOString()
  );
  const deferredCleanup = await cleanupJob.handleMoveCleanupJob(
    latePublishJob,
    new AbortController().signal
  );
  assert.equal(deferredCleanup.status, "reschedule");
  assert.ok(deferredCleanup.delayMs > 0);
  assert.equal(
    await jobs.rescheduleBackgroundJob(latePublishJob, deferredCleanup.delayMs),
    true
  );
  await localAccess.driver.writeBuffer(
    "full",
    latePublishKey,
    latePublishBody,
    "image/webp"
  );
  await new Promise((resolve) => setTimeout(
    resolve,
    deferredCleanup.delayMs + 25
  ));
  const latePublishRetryToken = randomUUID();
  const latePublishRetryJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [latePublishJob.id, latePublishRetryToken]
  )).rows[0];
  assert.deepEqual(
    await cleanupJob.handleMoveCleanupJob(
      latePublishRetryJob,
      new AbortController().signal
    ),
    { status: "succeeded" }
  );
  assert.equal(
    await jobs.markBackgroundJobSucceeded(latePublishRetryJob),
    true
  );
  assert.equal(
    await localAccess.driver.exists("full", latePublishKey),
    false,
    "不确定请求窗口结束后必须清理迟到发布的候选对象"
  );

  const guardedLatePublishImage = randomUUID();
  const guardedLatePublishKey = imagePaths.storageObjectKey(
    guardedLatePublishImage,
    "webp"
  );
  const guardedLatePublishBody = Buffer.from(
    "ingestion-guarded-late-publish"
  );
  const guardedLatePublishToken = randomUUID();
  let lateGuardPublish;
  const guardedSourcePath = join(runtime.dataDirectory, "guarded-source.webp");
  await writeFile(guardedSourcePath, guardedLatePublishBody);
  const guardedTransferStorage: StorageAccess = {
    config: {
      slug: "local",
      type: "s3",
      s3: { ...mergeS3Settings(), task_timeout_seconds: 0.5 }
    },
    driver: controlledStorageDriver({
      async exists() { return false; },
      async writeStream(toPrefix, toKey) {
        assert.equal(toPrefix, "full");
        assert.equal(toKey, guardedLatePublishKey);
        const armedBeforeWrite = (await database.pool.query(
          "SELECT payload->>'confirm_absent_after' AS deadline "
            + "FROM background_job WHERE id=$1",
          [guardedLatePublishJob.id]
        )).rows[0]?.deadline;
        assert.ok(
          Date.parse(armedBeforeWrite) >= Date.now() + 1_300,
          "PutObject 请求不得先于持久 guard 窗口"
        );
        lateGuardPublish = new Promise((resolve, reject) => {
          setTimeout(() => {
            localAccess.driver.writeBuffer(
              "full",
              guardedLatePublishKey,
              guardedLatePublishBody,
              "image/webp"
            ).then(resolve, reject);
          }, 50);
        });
        throw new Error("injected PutObject response loss");
      }
    })
  };
  const guardedTarget = await objectTransfer.verifyStorageTarget({
    storage: guardedTransferStorage,
    prefix: "full",
    key: guardedLatePublishKey,
    expected: {
      size: guardedLatePublishBody.length,
      sha256: createHash("sha256").update(guardedLatePublishBody).digest("hex")
    }
  });
  await cleanup.enqueueObjectsForCleanup(
    guardedLatePublishImage,
    [{ prefix: "full", key: guardedLatePublishKey, backend: "local" }],
    "ingestion_commit_candidate_guard",
    { guardToken: guardedLatePublishToken }
  );
  let guardedLatePublishJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [guardedLatePublishImage, randomUUID()]
  )).rows[0];
  assert.equal(guardedLatePublishJob.payload.confirm_absent_after, undefined,
    "worker 领取预建 guard 时可以尚未观察到 S3 请求窗口");
  const guardedTransferStartedAt = Date.now();
  await assert.rejects(
    objectTransfer.writeVerifiedFileToStorage({
      target: guardedTarget,
      sourcePath: guardedSourcePath,
      contentType: "image/webp",
      ownedIngestionCandidateGuard: {
        imageId: guardedLatePublishImage,
        token: guardedLatePublishToken
      }
    }),
    /injected PutObject response loss/
  );
  const persistedGuardDeadline = (await database.pool.query(
    "SELECT payload->>'confirm_absent_after' AS deadline "
      + "FROM background_job WHERE id=$1",
    [guardedLatePublishJob.id]
  )).rows[0]?.deadline;
  assert.ok(
    Date.parse(persistedGuardDeadline) >= guardedTransferStartedAt + 1_400,
    "PutObject 发出前必须让预建 guard 覆盖请求、校验与迟到发布窗口"
  );
  const staleGuardOutcome = await cleanupJob.handleMoveCleanupJob(
    guardedLatePublishJob,
    new AbortController().signal
  );
  assert.equal(staleGuardOutcome.status, "reschedule");
  assert.ok(
    staleGuardOutcome.delayMs > 0,
    "已经领取的 guard 必须在单图锁内重读后来写入的截止时间"
  );
  assert.equal(
    await jobs.rescheduleBackgroundJob(
      guardedLatePublishJob,
      staleGuardOutcome.delayMs
    ),
    true
  );
  await lateGuardPublish;
  assert.equal(
    await localAccess.driver.exists("full", guardedLatePublishKey),
    true,
    "客户端失败后远端仍可在保护窗口内迟到发布"
  );
  await new Promise((resolve) => setTimeout(
    resolve,
    Math.max(0, Date.parse(persistedGuardDeadline) - Date.now()) + 25
  ));
  guardedLatePublishJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [guardedLatePublishJob.id, randomUUID()]
  )).rows[0];
  assert.deepEqual(
    await cleanupJob.handleMoveCleanupJob(
      guardedLatePublishJob,
      new AbortController().signal
    ),
    { status: "succeeded" }
  );
  assert.equal(
    await jobs.markBackgroundJobSucceeded(guardedLatePublishJob),
    true
  );
  assert.equal(
    await localAccess.driver.exists("full", guardedLatePublishKey),
    false,
    "预建 guard 必须在完整窗口后删除迟到发布且未入库的正式候选"
  );

  for (const contentMd5 of [false, true]) {
  const settledGuardImage = randomUUID();
  const settledGuardKey = imagePaths.storageObjectKey(
    settledGuardImage,
    "webp"
  );
  const settledGuardToken = randomUUID();
  let settledTargetBody: Buffer | undefined;
  const settledSourceBody = Buffer.from("ingestion-guard-settled-upload");
  const settledSourcePath = join(runtime.dataDirectory, "settled-source.webp");
  await writeFile(settledSourcePath, settledSourceBody);
  const settledTransferStorage: StorageAccess = {
    config: {
      slug: "local",
      type: "s3",
      capabilities: { content_md5: contentMd5 },
      s3: { ...mergeS3Settings(), task_timeout_seconds: 0.5 }
    },
    driver: controlledStorageDriver({
      async openRead(prefix, key) {
        const body = settledTargetBody;
        assert.equal(prefix, "full");
        assert.ok(body);
        assert.equal(key, settledGuardKey);
        return {
          body: Readable.from([body]),
          size: body.length,
          totalSize: body.length,
          backend: "s3"
        };
      },
      async exists() { return false; },
      async writeStream(_prefix, _key, body, _size, _type, options) {
        const deadline = (await database.pool.query(
          "SELECT payload->>'confirm_absent_after' AS deadline FROM background_job WHERE target_id=$1",
          [settledGuardImage]
        )).rows[0]?.deadline;
        assert.ok(Date.parse(deadline) >= Date.now() + (contentMd5 ? 800 : 1_300));
        assert.equal(options?.expectedMd5, contentMd5
          ? createHash("md5").update(settledSourceBody).digest("hex") : undefined);
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        settledTargetBody = Buffer.concat(chunks);
      }
    })
  };
  const settledTarget = await objectTransfer.verifyStorageTarget({
    storage: settledTransferStorage,
    prefix: "full",
    key: settledGuardKey,
    expected: {
      size: settledSourceBody.length,
      sha256: createHash("sha256").update(settledSourceBody).digest("hex")
    }
  });
  await cleanup.enqueueObjectsForCleanup(
    settledGuardImage,
    [{ prefix: "full", key: settledGuardKey, backend: "local" }],
    "ingestion_commit_candidate_guard",
    { guardToken: settledGuardToken }
  );
  assert.deepEqual(
    await objectTransfer.writeVerifiedFileToStorage({
      target: settledTarget,
      sourcePath: settledSourcePath,
      contentType: "image/webp",
      ownedIngestionCandidateGuard: {
        imageId: settledGuardImage,
        token: settledGuardToken
      }
    }),
    {
      created: true,
      sourceDigest: {
        size: settledSourceBody.length,
        sha256: createHash("sha256").update(settledSourceBody).digest("hex"),
        ...(contentMd5 ? { md5: createHash("md5").update(settledSourceBody).digest("hex") } : {})
      }
    }
  );
  assert.equal(
    (await database.pool.query(
      "SELECT payload ? 'confirm_absent_after' AS armed "
        + "FROM background_job WHERE type='move.cleanup' AND target_id=$1",
      [settledGuardImage]
    )).rows[0]?.armed,
    false,
    "PutObject 与目标摘要均确认后应解除 guard 的不确定窗口"
  );
  await database.pool.query(
    "DELETE FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [settledGuardImage]
  );
  }

  const admittedCleanupImage = randomUUID();
  const admittedCleanupKey = imagePaths.storageObjectKey(
    admittedCleanupImage,
    "webp"
  );
  await localAccess.driver.writeBuffer(
    "full",
    admittedCleanupKey,
    Buffer.from("move-cleanup-admitted-cancel"),
    "image/webp"
  );
  const admittedCleanupObjects = await cleanup.captureMoveCleanupObjects([
    { prefix: "full", key: admittedCleanupKey, backend: "local" }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    admittedCleanupImage,
    admittedCleanupObjects,
    "test_cleanup_admitted_cancel"
  );
  const admittedCleanupToken = randomUUID();
  const admittedCleanupJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [admittedCleanupImage, admittedCleanupToken]
  )).rows[0];
  assert.ok(admittedCleanupJob);
  const admittedCleanupController = new AbortController();
  const admittedCleanupReason = new Error(
    "injected move cleanup cancellation after delete"
  );
  const originalAdmittedCleanupRemove = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let admittedCleanupDeleteStarted = false;
  localAccess.driver.removeObjects = async (objects, options) => {
    const results = await originalAdmittedCleanupRemove(objects, options);
    if (objects.some((object) => object.key === admittedCleanupKey)) {
      admittedCleanupDeleteStarted = true;
      admittedCleanupController.abort(admittedCleanupReason);
    }
    return results;
  };
  let admittedCleanupResult;
  try {
    admittedCleanupResult = await database.runWithAdvisoryLockAcquisitionSignal(
      admittedCleanupController.signal,
      () => cleanupJob.handleMoveCleanupJob(
        admittedCleanupJob,
        admittedCleanupController.signal
      )
    );
  } finally {
    localAccess.driver.removeObjects = originalAdmittedCleanupRemove;
  }
  assert.equal(admittedCleanupDeleteStarted, true);
  assert.deepEqual(admittedCleanupResult, { status: "succeeded" });
  assert.equal(
    await localAccess.driver.exists("full", admittedCleanupKey),
    false,
    "已准入的 move cleanup 必须接收删除结果"
  );
  assert.equal(await jobs.markBackgroundJobSucceeded(admittedCleanupJob), true);

  const abortedImage = randomUUID();
  const abortedObjectKey = imagePaths.storageObjectKey(abortedImage, "webp");
  const abortedBody = Buffer.from("cancelled-move-cleanup");
  await localAccess.driver.writeBuffer(
    "thumbs",
    abortedObjectKey,
    abortedBody,
    "image/webp"
  );
  const [abortedCleanupObject] = await cleanup.captureMoveCleanupObjects([
    { prefix: "thumbs", key: abortedObjectKey, backend: "local" }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    abortedImage,
    [abortedCleanupObject],
    "test_cancelled_move_cleanup"
  );
  const abortedExecutionToken = randomUUID();
  const abortedReceipt = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [abortedImage, abortedExecutionToken]
  )).rows[0];
  assert.ok(abortedReceipt);
  const cleanupAbort = new AbortController();
  const restoreCleanupQuery = interceptSqlQueries(database.pool, async (text, values, query) => {
    const result = await query();
    if (
      typeof text === "string"
      && text.includes("SELECT object_key, storage_slug")
      && Array.isArray(values) && values[0] === abortedImage
    ) {
      cleanupAbort.abort(new Error("injected lock loss before cleanup delete"));
    }
    return result;
  });
  try {
    await assert.rejects(() => database.runWithAdvisoryLockAcquisitionSignal(
      cleanupAbort.signal,
      () => cleanupJob.handleMoveCleanupJob(
        abortedReceipt,
        cleanupAbort.signal
      )
    ));
  } finally {
    restoreCleanupQuery();
  }
  assert.deepEqual(
    await localAccess.driver.readBuffer("thumbs", abortedObjectKey),
    abortedBody,
    "取消后不得删除尚未开始处理的捕获对象"
  );
  await database.pool.query(
    "DELETE FROM background_job WHERE id=$1",
    [abortedReceipt.id]
  );
  await removeDriverObject(localAccess.driver, "thumbs", abortedObjectKey);
});
