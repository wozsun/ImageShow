import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IngestionSessionSnapshot } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import {
  runIntegrationScenario
} from "./integration-runtime.mts";
import {
  freezeFixtureCommit,
  runWithReadyIngestionFixture
} from "./ingestion-fixture.mts";

type CleanupJobModule = typeof import(
  "../../../../packages/server/src/storage/cleanup/job.ts"
);
type CommitWorkerModule = typeof import(
  "../../../../packages/server/src/images/ingestion/commit/worker.ts"
);
type IrreversibleCoordinatorModule = typeof import(
  "../../../../packages/server/src/images/ingestion/execution/irreversible-coordinator.ts"
);

await runIntegrationScenario(async (runtime) => {
  const commitWorker = await import(
    runtime.moduleUrl("packages/server/src/images/ingestion/commit/worker.ts")
  ) as CommitWorkerModule;
  const cleanupJob = await import(
    runtime.moduleUrl("packages/server/src/storage/cleanup/job.ts")
  ) as CleanupJobModule;
  const coordinatorModule = await import(
    runtime.moduleUrl(
      "packages/server/src/images/ingestion/execution/irreversible-coordinator.ts"
    )
  ) as IrreversibleCoordinatorModule;
  await runWithReadyIngestionFixture(runtime, "commit-recovery", async (fixture) => {
    await runtime.databasePools.pool.query(
      "INSERT INTO admin_account(username, password_hash, role) "
        + "SELECT 'integration-conflict', password_hash, 'image' "
        + "FROM admin_account WHERE username='integration-admin'"
    );
    const committing = await freezeFixtureCommit(fixture);
    await runtime.databasePools.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, width, height, image_size, "
        + "thumbnail_size, image_time, title) VALUES "
        + "($1,'integration-conflict','local',$2,'pc','dark','none','webp',"
        + "$3,1200,800,$4,$5,$6,'conflicting owner')",
      [
        fixture.imageId,
        fixture.finalObjectKey,
        fixture.prepared.md5,
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
      (error: unknown) => (
        (error as { code?: unknown }).code === "ingestion_image_owner_conflict"
      )
    );
    assert.equal(
      (await runtime.databasePools.pool.query<{ created_by: string }>(
        "SELECT created_by FROM metadata WHERE id=$1",
        [fixture.imageId]
      )).rows[0]?.created_by,
      "integration-conflict"
    );
    const guard = (await runtime.databasePools.pool.query<{
      id: string;
    }>(
      "SELECT id FROM background_job WHERE target_id=$1 "
        + "AND type='move.cleanup' AND status='pending'",
      [fixture.imageId]
    )).rows[0];
    assert.ok(guard?.id, "copy attempt must persist its cleanup guard first");
    await runtime.databasePools.pool.query(
      "DELETE FROM metadata WHERE id=$1",
      [fixture.imageId]
    );
    const runningGuard = (await runtime.databasePools.pool.query(
      "UPDATE background_job SET status='running', execution_token=$2 "
        + "WHERE id=$1 RETURNING *",
      [guard.id, randomUUID()]
    )).rows[0];
    await cleanupJob.handleMoveCleanupJob(
      runningGuard,
      new AbortController().signal
    );
    assert.equal(
      await fixture.localDriver.exists("full", fixture.finalObjectKey),
      false
    );
    assert.equal(
      await fixture.localDriver.exists("thumbs", fixture.finalThumbnailKey),
      false
    );
  });
});
