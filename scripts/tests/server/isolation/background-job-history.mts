import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { appConfig } from "@imageshow/shared";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async ({ databasePools: { pool } }) => {
  const jobs = await import("../../../../packages/server/src/jobs/repository.ts");
  const writer = await pool.connect();
  const { pid } = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0];
  const previousBatchSize = appConfig.backgroundJob.historyCleanupBatchSize;
  const expiredAge = Math.max(
    appConfig.backgroundJob.completedRetentionSeconds,
    appConfig.backgroundJob.failedRetentionSeconds
  ) + 60;
  let cleanup: ReturnType<typeof jobs.cleanupBackgroundJobHistory> | undefined;
  appConfig.backgroundJob.historyCleanupBatchSize = 1;
  try {
    for (const previousStatus of ["succeeded", "failed"]) {
      const renewedId = randomUUID();
      const expiredId = randomUUID();
      const idempotencyKey = `history-rerun:${renewedId}`;
      await pool.query(
        "INSERT INTO background_job(id, type, status, target_id, payload, idempotency_key, updated_at) "
          + "VALUES ($1, 'move.cleanup', $3, 'old-target', '{}'::jsonb, $4, "
          + "now() - (($5::int + 60) || ' seconds')::interval), "
          + "($2, 'move.cleanup', 'succeeded', 'expired-target', '{}'::jsonb, NULL, "
          + "now() - ($5 || ' seconds')::interval)",
        [renewedId, expiredId, previousStatus, idempotencyKey, expiredAge]
      );
      await writer.query("BEGIN");
      await jobs.enqueueRerunnableJob(
        "move.cleanup", "renewed-target", { marker: "renewed-payload" }, idempotencyKey, writer
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
      }, `${previousStatus} 历史任务重新入队后必须保留新的任务意图`);
      assert.deepEqual(removed, [{ status: "succeeded", count: 1 }]);
      assert.equal((await pool.query(
        "SELECT id FROM background_job WHERE id=$1", [expiredId]
      )).rowCount, 0, "跳过正在重新入队的旧候选后，仍应清理其他过期任务");
      assert.deepEqual(await jobs.cleanupBackgroundJobHistory(), [], "新 pending 任务不属于历史清理对象");
    }
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    if (cleanup) await Promise.allSettled([cleanup]);
    appConfig.backgroundJob.historyCleanupBatchSize = previousBatchSize;
  }
});
