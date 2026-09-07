import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { BackgroundJob } from "../../../../packages/server/src/jobs/types.ts";
import { interceptSqlQueries } from "./database-faults.mts";

import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const jobs = await import("../../../../packages/server/src/jobs/repository.ts");
const registry = await import("../../../../packages/server/src/storage/backends/registry.ts");
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const trash = await import("../../../../packages/server/src/images/trash-purge.ts");
const trashMutations = await import("../../../../packages/server/src/images/trash-mutations.ts");
const trashMembershipLock = await import("../../../../packages/server/src/images/trash-membership-lock.ts");
const trashPurgeJob = await import("../../../../packages/server/src/images/trash-purge-job.ts");
const trashPurgeMaintenance = await import("../../../../packages/server/src/images/trash-purge-maintenance.ts");
const databaseCheck = await import("../../../../packages/server/src/checks/database-check.ts");
const sharedAppConfig = await import("@imageshow/shared");
const localAccess = await registry.resolveStorageAccess("local");
const foregroundImage = randomUUID();
await database.pool.query("INSERT INTO metadata (id,created_by,status,storage_slug,object_key,device,brightness,theme,ext,md5) VALUES ($1,'integration-admin','ready','local',$2,'pc','dark','none','webp',$3)",[foregroundImage,imagePaths.storageObjectKey(foregroundImage,"webp"),"0".repeat(32)]);
  const claimTrashPurgeJob = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = await jobs.claimBackgroundJob("trash.purge");
      if (job) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("trash.purge job was not claimable");
  };
  const finishTrashPurgeJob = async (initialJob: BackgroundJob) => {
    let job = initialJob;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const outcome = await trashPurgeJob.handleTrashPurgeJob(
        job,
        new AbortController().signal
      );
      if (outcome.status === "succeeded") {
        assert.equal(await jobs.markBackgroundJobSucceeded(job), true);
        return;
      }
      assert.equal(
        await jobs.rescheduleBackgroundJob(job, outcome.delayMs),
        true
      );
      job = await claimTrashPurgeJob();
    }
    assert.fail("trash.purge job did not settle");
  };

  const uncertainImage = randomUUID();
  const uncertainObjectKey = imagePaths.storageObjectKey(uncertainImage, "webp");
  const uncertainThumbKey = imagePaths.thumbnailObjectKey(uncertainObjectKey);
  const uncertainFull = Buffer.from("uncertain-purge-full");
  const uncertainThumbnail = Buffer.from("uncertain-purge-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
      + "($1, 'integration-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, now())",
    [
      uncertainImage,
      uncertainObjectKey,
      createHash("md5").update(uncertainFull).digest("hex"),
      uncertainThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    uncertainObjectKey,
    uncertainFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    uncertainThumbKey,
    uncertainThumbnail,
    "image/webp"
  );
  let metadataDeleteResponseLost = false;
  const restoreDeleteResponse = interceptSqlQueries(database.pool, async (statement, values, query) => {
    if (
      !metadataDeleteResponseLost
      && typeof statement === "string"
      && statement.includes("DELETE FROM metadata")
      && Array.isArray(values)
      && values[0] === uncertainImage
    ) {
      metadataDeleteResponseLost = true;
      await query();
      throw new Error("injected metadata delete response loss");
    }
    return query();
  });
  const uncertainPurgePromise = trash.purgeImages({
    scope: "selected",
    ids: [uncertainImage]
  });
  const uncertainPurgeJob = await claimTrashPurgeJob();
  try {
    await finishTrashPurgeJob(uncertainPurgeJob);
  } finally {
    restoreDeleteResponse();
  }
  const uncertainPurge = await uncertainPurgePromise;
  assert.equal(metadataDeleteResponseLost, true);
  assert.deepEqual(uncertainPurge, {
    requested: 1,
    queued: 1,
    already_queued: 0,
    deleted: 1,
    remaining: 0,
    ignored: 0
  });
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=$1",
      [uncertainImage]
    )).rows[0]?.count),
    0
  );

  const admittedCancelImage = randomUUID();
  const admittedCancelObjectKey = imagePaths.storageObjectKey(admittedCancelImage, "webp");
  const admittedCancelThumbKey = imagePaths.thumbnailObjectKey(
    admittedCancelObjectKey
  );
  const admittedCancelFull = Buffer.from("admitted-cancel-purge-full");
  const admittedCancelThumbnail = Buffer.from("admitted-cancel-purge-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
      + "($1, 'integration-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', "
      + "'webp', $3, $4, now())",
    [
      admittedCancelImage,
      admittedCancelObjectKey,
      createHash("md5").update(admittedCancelFull).digest("hex"),
      admittedCancelThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    admittedCancelObjectKey,
    admittedCancelFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    admittedCancelThumbKey,
    admittedCancelThumbnail,
    "image/webp"
  );
  const admittedCancelController = new AbortController();
  const admittedCancelReason = new Error(
    "injected purge cancellation after delete"
  );
  const originalAdmittedPurgeRemove = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let admittedPurgeDeleteStarted = false;
  localAccess.driver.removeObjects = async (objects, options) => {
    const results = await originalAdmittedPurgeRemove(objects, options);
    if (objects.some((object) => object.key === admittedCancelObjectKey)) {
      admittedPurgeDeleteStarted = true;
      admittedCancelController.abort(admittedCancelReason);
    }
    return results;
  };
  const admittedCancelPurge = trash.purgeImages({
    scope: "selected",
    ids: [admittedCancelImage]
  }, { signal: admittedCancelController.signal }).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  );
  const admittedCancelPurgeJob = await claimTrashPurgeJob();
  assert.equal(
    admittedPurgeDeleteStarted,
    false,
    "HTTP 请求等待期间不得执行对象删除"
  );
  assert.deepEqual(await trashMutations.restoreImages([admittedCancelImage]), {
    requested: 1,
    restored: 0,
    ignored: 1,
    results: [{ id: admittedCancelImage, status: "ignored" }]
  });
  try {
    await finishTrashPurgeJob(admittedCancelPurgeJob);
  } finally {
    localAccess.driver.removeObjects = originalAdmittedPurgeRemove;
  }
  assert.equal(admittedPurgeDeleteStarted, true);
  const admittedCancelOutcome = await admittedCancelPurge;
  assert.equal(admittedCancelOutcome.value, null);
  assert.equal(admittedCancelOutcome.error, admittedCancelReason);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=$1",
      [admittedCancelImage]
    )).rows[0]?.count),
    0,
    "物理删除开始后的调度取消必须继续完成 metadata 删除"
  );
  assert.equal(
    await localAccess.driver.exists("full", admittedCancelObjectKey),
    false
  );
  assert.equal(
    await localAccess.driver.exists("thumbs", admittedCancelThumbKey),
    false
  );
  const interruptedImage = randomUUID();
  const interruptedObjectKey = imagePaths.storageObjectKey(interruptedImage, "webp");
  const interruptedThumbKey = imagePaths.thumbnailObjectKey(
    interruptedObjectKey
  );
  const interruptedFull = Buffer.from("interrupted-purge-full");
  const interruptedThumbnail = Buffer.from("interrupted-purge-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
      + "($1, 'integration-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, now())",
    [
      interruptedImage,
      interruptedObjectKey,
      createHash("md5").update(interruptedFull).digest("hex"),
      interruptedThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    interruptedObjectKey,
    interruptedFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    interruptedThumbKey,
    interruptedThumbnail,
    "image/webp"
  );
  const interruptedController = new AbortController();
  const interruptedReason = new Error("injected purge request interruption");
  const interruptedRequest = trash.purgeImages(
    { scope: "selected", ids: [interruptedImage] },
    { signal: interruptedController.signal }
  );
  const interruptedContinuation = await claimTrashPurgeJob();
  assert.deepEqual(interruptedContinuation.payload, {
    retain_exhausted: true
  });
  assert.equal(
    (await database.pool.query(
      "SELECT purge_job_id FROM metadata WHERE id=$1",
      [interruptedImage]
    )).rows[0]?.purge_job_id,
    interruptedContinuation.id
  );
  interruptedController.abort(interruptedReason);
  await assert.rejects(
    interruptedRequest,
    (error) => error === interruptedReason
  );
  await finishTrashPurgeJob(interruptedContinuation);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=$1",
      [interruptedImage]
    )).rows[0]?.count),
    0
  );

  const concurrentImage = randomUUID();
  const concurrentObjectKey = imagePaths.storageObjectKey(concurrentImage, "webp");
  const concurrentThumbKey = imagePaths.thumbnailObjectKey(concurrentObjectKey);
  const concurrentFull = Buffer.from("concurrent-trash-full");
  const concurrentThumbnail = Buffer.from("concurrent-trash-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES ($1, 'integration-admin', 'local', $2, 'pc', "
      + "'dark', 'none', 'webp', $3, $4)",
    [
      concurrentImage,
      concurrentObjectKey,
      createHash("md5").update(concurrentFull).digest("hex"),
      concurrentThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    concurrentObjectKey,
    concurrentFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    concurrentThumbKey,
    concurrentThumbnail,
    "image/webp"
  );
  const concurrentMutation = await database.pool.connect();
  let concurrentMutationFinished = false;
  let concurrentPurgePromise = null;
  try {
    await concurrentMutation.query("BEGIN");
    await trashMembershipLock.lockTrashMembershipForTransaction(
      concurrentMutation
    );
    await concurrentMutation.query(
      "UPDATE metadata SET status='deleted', deleted_at=clock_timestamp() "
        + "WHERE id=$1",
      [concurrentImage]
    );
    concurrentPurgePromise = trash.purgeImages({
      scope: "selected",
      ids: [concurrentImage]
    });
    let captureIsWaiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await database.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity "
          + "WHERE datname=current_database() AND pid<>pg_backend_pid() "
          + "AND wait_event_type='Lock' AND wait_event='advisory'"
      );
      if (Number(waiting.rows[0]?.count) > 0) {
        captureIsWaiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(captureIsWaiting, true);
    await concurrentMutation.query("COMMIT");
    concurrentMutationFinished = true;
    const concurrentContinuation = await claimTrashPurgeJob();
    await finishTrashPurgeJob(concurrentContinuation);
    const concurrentPurge = await concurrentPurgePromise;
    assert.deepEqual(concurrentPurge, {
      requested: 1,
      queued: 1,
      already_queued: 0,
      deleted: 1,
      remaining: 0,
      ignored: 0
    });
    assert.equal(
      Number((await database.pool.query(
        "SELECT count(*) FROM metadata WHERE id=$1",
        [concurrentImage]
      )).rows[0]?.count),
      0
    );
    assert.equal(
      await localAccess.driver.exists("full", concurrentObjectKey),
      false
    );
    assert.equal(
      await localAccess.driver.exists("thumbs", concurrentThumbKey),
      false
    );
  } finally {
    if (!concurrentMutationFinished) {
      await concurrentMutation.query("ROLLBACK").catch(() => undefined);
    }
    concurrentMutation.release();
    if (concurrentPurgePromise && !concurrentMutationFinished) {
      await concurrentPurgePromise.catch(() => undefined);
    }
  }

  await database.pool.query(
    "DELETE FROM metadata WHERE status='deleted'"
  );
  const previousTrashBatchSize = sharedAppConfig.appConfig.trashBatchSize;
  sharedAppConfig.appConfig.trashBatchSize = 1;
  try {
    const createTrashImage = async (ageSeconds: number) => {
      const id = randomUUID();
      const objectKey = imagePaths.storageObjectKey(id, "webp");
      const thumbKey = imagePaths.thumbnailObjectKey(objectKey);
      const full = Buffer.from("watermark-full-" + id);
      const thumbnail = Buffer.from("watermark-thumb-" + id);
      await database.pool.query(
        "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
          + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
          + "($1, 'integration-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, "
          + "$4, clock_timestamp() - ($5 || ' seconds')::interval)",
        [
          id,
          objectKey,
          createHash("md5").update(full).digest("hex"),
          thumbnail.byteLength,
          ageSeconds
        ]
      );
      await localAccess.driver.writeBuffer(
        "full",
        objectKey,
        full,
        "image/webp"
      );
      await localAccess.driver.writeBuffer(
        "thumbs",
        thumbKey,
        thumbnail,
        "image/webp"
      );
      return { id, objectKey, thumbKey };
    };

    const oldest = await createTrashImage(3);
    const middle = await createTrashImage(2);
    const newest = await createTrashImage(1);
    const allPurgePromise = trash.purgeImages({ scope: "all" });
    const allPurgeJob = await claimTrashPurgeJob();
    assert.deepEqual(
      (await database.pool.query(
        "SELECT id FROM metadata WHERE purge_job_id=$1 ORDER BY deleted_at, id",
        [allPurgeJob.id]
      )).rows.map((row) => row.id),
      [oldest.id, middle.id, newest.id]
    );
    assert.deepEqual(await trashMutations.restoreImages([middle.id]), {
      requested: 1,
      restored: 0,
      ignored: 1,
      results: [{ id: middle.id, status: "ignored" }]
    });

    const addedAfterCapture = await createTrashImage(0);
    await finishTrashPurgeJob(allPurgeJob);
    const allPurge = await allPurgePromise;
    assert.deepEqual(allPurge, {
      requested: 3,
      queued: 3,
      already_queued: 0,
      deleted: 3,
      remaining: 0,
      ignored: 0
    });
    assert.deepEqual(
      (await database.pool.query(
        "SELECT id, purge_job_id FROM metadata WHERE id=$1",
        [addedAfterCapture.id]
      )).rows,
      [{ id: addedAfterCapture.id, purge_job_id: null }],
      "scope all 只处理事务快照，不包含之后进入回收站的图片"
    );

    const selectedPurgePromise = trash.purgeImages({
      scope: "selected",
      ids: [addedAfterCapture.id]
    });
    await finishTrashPurgeJob(await claimTrashPurgeJob());
    const selectedPurge = await selectedPurgePromise;
    assert.deepEqual(selectedPurge, {
      requested: 1,
      queued: 1,
      already_queued: 0,
      deleted: 1,
      remaining: 0,
      ignored: 0
    });
    const ignoredPurge = await trash.purgeImages({
      scope: "selected",
      ids: [foregroundImage]
    });
    assert.deepEqual(ignoredPurge, {
      requested: 1,
      queued: 0,
      already_queued: 0,
      deleted: 0,
      remaining: 0,
      ignored: 1
    });

    const failedItem = await createTrashImage(0);
    const failedPurgePromise = trash.purgeImages({
      scope: "selected",
      ids: [failedItem.id]
    });
    const failedJob = await claimTrashPurgeJob();
    const originalFailedRemove = localAccess.driver.removeObjects.bind(
      localAccess.driver
    );
    let failedRemoveObserved = false;
    localAccess.driver.removeObjects = async (objects, options) => {
      if (objects.some((object) => object.key === failedItem.objectKey)) {
        failedRemoveObserved = true;
        throw new Error("injected trash purge driver failure");
      }
      return originalFailedRemove(objects, options);
    };
    let failedJobError: Error | undefined;
    try {
      await assert.rejects(
        trashPurgeJob.handleTrashPurgeJob(failedJob, new AbortController().signal),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          failedJobError = error;
          return true;
        }
      );
      assert.equal(failedRemoveObserved, true);
    } finally {
      localAccess.driver.removeObjects = originalFailedRemove;
    }
    assert.equal(
      await jobs.markBackgroundJobFailed(failedJob, failedJobError),
      true
    );
    assert.deepEqual(await failedPurgePromise, {
      requested: 1,
      queued: 1,
      already_queued: 0,
      deleted: 0,
      remaining: 1,
      ignored: 0
    });
    const retryingTrashCheck = await databaseCheck.checkTrash();
    assert.equal(retryingTrashCheck.purge_pending_count, 1);
    assert.equal(retryingTrashCheck.job_counts.retrying, 1);
    assert.equal(
      retryingTrashCheck.jobs.find((job) => job.id === failedJob.id)?.state,
      "retrying"
    );
    assert.deepEqual(await trash.purgeImages({
      scope: "selected",
      ids: [failedItem.id]
    }), {
      requested: 1,
      queued: 0,
      already_queued: 1,
      deleted: 0,
      remaining: 1,
      ignored: 0
    });
    assert.deepEqual(await trashMutations.restoreImages([failedItem.id]), {
      requested: 1,
      restored: 0,
      ignored: 1,
      results: [{ id: failedItem.id, status: "ignored" }]
    });
    await database.pool.query(
      "UPDATE background_job SET next_retry_at=NULL "
        + "WHERE id=$1",
      [failedJob.id]
    );
    const exhaustedTrashCheck = await databaseCheck.checkTrash();
    assert.equal(exhaustedTrashCheck.job_counts.exhausted, 1);
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 1,
        retried_images: 1,
        repaired_jobs: 0,
        repaired_images: 0
      }
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());

    const missingReferenceItem = await createTrashImage(0);
    const missingReferenceJob = randomUUID();
    await database.pool.query(
      "UPDATE metadata SET purge_job_id=$2 WHERE id=$1",
      [missingReferenceItem.id, missingReferenceJob]
    );
    const missingReferenceCheck = await databaseCheck.checkTrash();
    assert.equal(
      missingReferenceCheck.issues.find(
        (issue) => issue.kind === "missing_job_reference"
      )?.count,
      1
    );
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 0,
        retried_images: 0,
        repaired_jobs: 1,
        repaired_images: 1
      }
    );
    assert.notEqual(
      (await database.pool.query(
        "SELECT purge_job_id FROM metadata WHERE id=$1",
        [missingReferenceItem.id]
      )).rows[0]?.purge_job_id,
      missingReferenceJob
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());

    const wrongSucceededReferenceItem = await createTrashImage(0);
    const wrongSucceededReferenceJob = randomUUID();
    await database.pool.query(
      "INSERT INTO background_job(id, type, status, target_id, payload) "
        + "VALUES($1, 'move.cleanup', 'succeeded', '', '{}'::jsonb)",
      [wrongSucceededReferenceJob]
    );
    await database.pool.query(
      "UPDATE metadata SET purge_job_id=$2 WHERE id=$1",
      [wrongSucceededReferenceItem.id, wrongSucceededReferenceJob]
    );
    const wrongSucceededReferenceCheck = await databaseCheck.checkTrash();
    assert.equal(
      wrongSucceededReferenceCheck.issues.find(
        (issue) => issue.kind === "wrong_job_type"
      )?.count,
      1
    );
    assert.equal(
      wrongSucceededReferenceCheck.issues.find(
        (issue) => issue.kind === "succeeded_job_reference"
      ),
      undefined,
      "同一错误类型任务不得再被 succeeded purge 分类重复统计"
    );
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 0,
        retried_images: 0,
        repaired_jobs: 1,
        repaired_images: 1
      }
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());
    await database.pool.query(
      "DELETE FROM background_job WHERE id=$1",
      [wrongSucceededReferenceJob]
    );

    const referencedHistoryItem = await createTrashImage(0);
    const referencedHistoryJob = randomUUID();
    const unreferencedHistoryJob = randomUUID();
    const retainedMoveHistoryJob = randomUUID();
    await database.pool.query(
      "INSERT INTO background_job("
        + "id, type, status, target_id, payload, error, next_retry_at, updated_at"
        + ") VALUES "
        + "($1, 'trash.purge', 'failed', '', $5::jsonb, 'exhausted', NULL, "
        + "now() - ($4 || ' seconds')::interval), "
        + "($2, 'trash.purge', 'failed', '', $5::jsonb, 'orphaned', NULL, "
        + "now() - ($4 || ' seconds')::interval), "
        + "($3, 'move.cleanup', 'failed', 'retained-history', $5::jsonb, "
        + "'protected cleanup receipt', NULL, "
        + "now() - ($4 || ' seconds')::interval)",
      [
        referencedHistoryJob,
        unreferencedHistoryJob,
        retainedMoveHistoryJob,
        sharedAppConfig.appConfig.backgroundJob.failedRetentionSeconds + 1,
        JSON.stringify({ retain_exhausted: true })
      ]
    );
    await database.pool.query(
      "UPDATE metadata SET purge_job_id=$2 WHERE id=$1",
      [referencedHistoryItem.id, referencedHistoryJob]
    );
    assert.deepEqual(await jobs.cleanupBackgroundJobHistory(), [
      { status: "failed", count: 1 }
    ]);
    assert.deepEqual(
      (await database.pool.query(
        "SELECT id FROM background_job WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[
          referencedHistoryJob,
          unreferencedHistoryJob,
          retainedMoveHistoryJob
        ]]
      )).rows.map((row) => row.id),
      [referencedHistoryJob, retainedMoveHistoryJob].sort(),
      "无引用 purge 耗尽任务应按保留期裁剪，有引用 purge 与 move.cleanup 回执必须继续保留"
    );
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 1,
        retried_images: 1,
        repaired_jobs: 0,
        repaired_images: 0
      }
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());
    await database.pool.query(
      "DELETE FROM background_job WHERE id=$1",
      [retainedMoveHistoryJob]
    );

  } finally {
    sharedAppConfig.appConfig.trashBatchSize = previousTrashBatchSize;
  }

});
