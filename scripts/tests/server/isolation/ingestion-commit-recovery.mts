import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IngestionSessionSnapshot } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import {
  freezeFixtureCommit,
  runWithReadyIngestionFixture
} from "./ingestion-fixture.mts";

type CleanupJobModule = typeof import("../../../../packages/server/src/storage/cleanup/job.ts");
type CommitWorkerModule =
  typeof import("../../../../packages/server/src/images/ingestion/commit/worker.ts");
type IrreversibleCoordinatorModule =
  typeof import("../../../../packages/server/src/images/ingestion/execution/irreversible-coordinator.ts");

await runIntegrationScenario(async (runtime) => {
  const commitWorker = (await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/commit/worker.ts")
  )) as CommitWorkerModule;
  const cleanupJob = (await import(
    runtime.moduleUrl("packages/server/src/storage/cleanup/job.ts")
  )) as CleanupJobModule;
  const coordinatorModule = (await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/execution/irreversible-coordinator.ts")
  )) as IrreversibleCoordinatorModule;
  await runWithReadyIngestionFixture(runtime, "commit-recovery", async (fixture) => {
    await runtime.databasePools.pool.query(
      "INSERT INTO admin_account(username, password_hash, role) " +
        "SELECT 'integration-conflict', password_hash, 'image' " +
        "FROM admin_account WHERE username='integration-admin'"
    );
    const committing = await freezeFixtureCommit(fixture);
    await runtime.databasePools.pool.query(
      `INSERT INTO metadata (id,created_by,storage_slug,device,brightness,theme,image_time,title,l_width,l_height,l_byte_size,l_md5,m_width,m_height,m_byte_size,m_md5,s_width,s_height,s_byte_size,s_md5) VALUES ($1,'integration-conflict','local','pc','dark',NULL,$5,'conflicting owner',1200,800,GREATEST(1,$3),$2,1200,800,GREATEST(1,$3),$2,1200,800,GREATEST(1,$4),$2)`,
      [
        fixture.imageId,
        fixture.prepared?.variants.large.md5,
        fixture.imageBody.length,
        fixture.thumbnailBody.length,
        "2026-09-07T00:00:00.000Z"
      ]
    );
    await assert.rejects(
      commitWorker.commitIngestionSessionSnapshot(
        fixture.repository,
        new coordinatorModule.IngestionIrreversibleCoordinator(),
        committing as IngestionSessionSnapshot,
        new AbortController().signal
      ),
      (error: unknown) => (error as { code?: unknown }).code === "ingestion_image_owner_conflict"
    );
    assert.equal(
      (
        await runtime.databasePools.pool.query<{ created_by: string }>(
          "SELECT created_by FROM metadata WHERE id=$1",
          [fixture.imageId]
        )
      ).rows[0]?.created_by,
      "integration-conflict"
    );
    const guard = (
      await runtime.databasePools.pool.query<{
        id: string;
      }>(
        "SELECT id FROM background_job WHERE target_id=$1 " +
          "AND type='move.cleanup' AND status='pending'",
        [fixture.imageId]
      )
    ).rows[0];
    assert.ok(guard?.id, "copy attempt must persist its cleanup guard first");
    await runtime.databasePools.pool.query(
      "DELETE FROM metadata WHERE id=$1",
      [fixture.imageId]
    );
    const runningGuard = (
      await runtime.databasePools.pool.query(
        "UPDATE background_job SET status='running', execution_token=$2 " +
          "WHERE id=$1 RETURNING *",
        [guard.id, randomUUID()]
      )
    ).rows[0];
    await cleanupJob.handleMoveCleanupJob(
      runningGuard,
      new AbortController().signal
    );
    assert.equal(
      await fixture.driver.exists("large", fixture.finalObjectKey),
      false
    );
    assert.equal(
      await fixture.driver.exists("small", fixture.finalThumbnailKey),
      false
    );
  });
});
