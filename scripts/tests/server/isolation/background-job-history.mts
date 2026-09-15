import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { appConfig } from "@imageshow/shared";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async ({ databasePools: { pool } }) => {
  const jobs = await import("../../../../packages/server/src/jobs/repository.ts");
  const { retryExhaustedMoveCleanupJobs } = await import("../../../../packages/server/src/storage/cleanup/repository.ts");
  const expiredAge = Math.max(
    appConfig.backgroundJob.completedRetentionSeconds,
    appConfig.backgroundJob.failedRetentionSeconds
  ) + 60;
  for (const extraPayload of [{}, { retain_exhausted: true }]) {
    const histories = ["move.cleanup", "trash.purge", "cache.rebuild"].flatMap(type => (
      ["succeeded", "failed"].map(status => ({
        id: randomUUID(), type, status,
        payload: { ...extraPayload, reason: "history-contract", objects: [{
          backend: "local", namespace_identity: "history-namespace", prefix: "full", key: "history.webp"
        }] }
      }))
    ));
    await pool.query(
      "INSERT INTO background_job(id,type,status,target_id,payload,retry_count,updated_at) "
        + "SELECT id,type,status,id::text,payload,$2,now()-($3 || ' seconds')::interval "
        + "FROM jsonb_to_recordset($1::jsonb) AS input(id uuid,type text,status text,payload jsonb)",
      [JSON.stringify(histories), appConfig.backgroundJob.maxRetries, expiredAge]
    );
    const retained = histories.find(item => item.type === "move.cleanup" && item.status === "failed")!;
    assert.deepEqual((await jobs.cleanupBackgroundJobHistory()).sort((a, b) => a.status.localeCompare(b.status)), [
      { status: "failed", count: 2 }, { status: "succeeded", count: 3 }
    ]);
    assert.deepEqual((await pool.query("SELECT id,payload FROM background_job")).rows, [
      { id: retained.id, payload: retained.payload }
    ], "耗尽清理任务按类型保留完整对象引用，其他到期终态按期限裁剪");
    await retryExhaustedMoveCleanupJobs("local");
    const claimed = await jobs.claimBackgroundJob("move.cleanup");
    assert.ok(claimed);
    assert.equal(claimed.id, retained.id);
    assert.equal(claimed.retry_count, 0);
    assert.deepEqual(claimed.payload, retained.payload);
    assert.equal(await jobs.renewBackgroundJobLease(claimed), true);
    assert.equal(await jobs.rescheduleBackgroundJob(claimed, 0), true);
    const resumed = await jobs.claimBackgroundJob("move.cleanup");
    assert.ok(resumed);
    assert.equal(resumed.id, claimed.id);
    assert.notEqual(resumed.execution_token, claimed.execution_token);
    assert.equal(await jobs.renewBackgroundJobLease(claimed), false);
    assert.equal(await jobs.markBackgroundJobSucceeded(claimed), false);
    assert.equal(await jobs.markBackgroundJobFailed(resumed, new Error("cleanup retry")), true);
    assert.equal(await jobs.claimBackgroundJob("move.cleanup"), undefined, "退避期间不可领取");
    await pool.query("UPDATE background_job SET next_retry_at=now() WHERE id=$1", [resumed.id]);
    const retried = await jobs.claimBackgroundJob("move.cleanup");
    assert.ok(retried);
    assert.equal(retried.retry_count, 1);
    assert.equal(await jobs.markBackgroundJobSucceeded(retried), true);
    assert.deepEqual(await jobs.cleanupBackgroundJobHistory(), [], "刚完成的任务保留到期前的历史");
    await pool.query("DELETE FROM background_job WHERE id=$1", [retained.id]);
  }

  const writer = await pool.connect();
  const { pid } = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0];
  const previousBatchSize = appConfig.backgroundJob.historyCleanupBatchSize;
  let cleanup: ReturnType<typeof jobs.cleanupBackgroundJobHistory> | undefined;
  appConfig.backgroundJob.historyCleanupBatchSize = 1;
  try {
    for (const type of ["cache.rebuild", "move.cleanup"] as const) for (const previousStatus of ["succeeded", "failed"]) {
      const renewedId = randomUUID();
      const expiredId = randomUUID();
      const idempotencyKey = `history-rerun:${renewedId}`;
      await pool.query(
        "INSERT INTO background_job(id, type, status, target_id, payload, idempotency_key, updated_at) "
          + "VALUES ($1, $6, $3, 'old-target', '{}'::jsonb, $4, "
          + "now() - (($5::int + 60) || ' seconds')::interval), "
          + "($2, 'move.cleanup', 'succeeded', 'expired-target', '{}'::jsonb, NULL, "
          + "now() - ($5 || ' seconds')::interval)",
        [renewedId, expiredId, previousStatus, idempotencyKey, expiredAge, type]
      );
      await writer.query("BEGIN");
      await jobs.enqueueRerunnableJob(
        type, "renewed-target", { marker: "renewed-payload" }, idempotencyKey, writer
      );
      let settled = false;
      cleanup = jobs.cleanupBackgroundJobHistory();
      void cleanup.then(() => { settled = true; }, () => { settled = true; });

      // Commit only after cleanup has either finished or reached the writer's
      // row lock. This fixes the competing transaction order without sleeps
      // pretending that the DELETE has already chosen its candidate.
      const deadline = Date.now() + 4_000;
      let waitingOnWriter = false;
      while (!settled && !waitingOnWriter && Date.now() < deadline) {
        waitingOnWriter = (await pool.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
            + "WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) AS waiting",
          [pid]
        )).rows[0].waiting;
        if (!settled && !waitingOnWriter) await delay(10);
      }
      assert.ok(settled || waitingOnWriter, "历史清理必须进入已观察到的执行状态");
      await writer.query("COMMIT");
      const removed = await cleanup;
      cleanup = undefined;
      const renewed = (await pool.query(
        "SELECT status, target_id, payload FROM background_job WHERE id=$1", [renewedId]
      )).rows[0];
      assert.deepEqual(renewed, {
        status: "pending", target_id: "renewed-target", payload: { marker: "renewed-payload" }
      }, `${type} ${previousStatus} 历史任务重新入队后必须保留新的任务意图`);
      assert.deepEqual(removed, [{ status: "succeeded", count: 1 }]);
      assert.equal((await pool.query(
        "SELECT id FROM background_job WHERE id=$1", [expiredId]
      )).rowCount, 0, "跳过正在重新入队的旧候选后，仍应清理其他过期任务");
      assert.deepEqual(await jobs.cleanupBackgroundJobHistory(), [], "新 pending 任务不属于历史清理对象");
      await pool.query("DELETE FROM background_job WHERE id=$1", [renewedId]);
    }
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    if (cleanup) await Promise.allSettled([cleanup]);
    appConfig.backgroundJob.historyCleanupBatchSize = previousBatchSize;
  }
});
