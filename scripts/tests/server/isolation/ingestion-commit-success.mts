import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { ingestionPreparedPath } from "../../../../packages/server/src/images/ingestion/raw/paths.ts";
import type { IngestionSessionSnapshot } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import {
  runIntegrationScenario
} from "./integration-runtime.mts";
import {
  freezeFixtureCommit,
  runWithReadyIngestionFixture
} from "./ingestion-fixture.mts";

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
  const coordinatorModule = await import(
    runtime.moduleUrl(
      "packages/server/src/images/ingestion/execution/irreversible-coordinator.ts"
    )
  ) as IrreversibleCoordinatorModule;
  await runWithReadyIngestionFixture(runtime, "commit-success", async (fixture) => {
    const committing = await freezeFixtureCommit(fixture);
    const item = await commitWorker.commitIngestionSessionSnapshot(
      fixture.repository,
      new coordinatorModule.IngestionIrreversibleCoordinator(),
      committing as IngestionSessionSnapshot,
      new AbortController().signal
    );
    assert.equal(item?.id, fixture.imageId);
    const row = (await runtime.databasePools.pool.query<{
      created_by: string;
      md5: string;
      object_key: string;
      storage_slug: string;
    }>(
      "SELECT created_by, md5, object_key, storage_slug FROM metadata WHERE id=$1",
      [fixture.imageId]
    )).rows[0];
    assert.deepEqual(row, {
      created_by: fixture.owner,
      md5: fixture.prepared.md5,
      object_key: fixture.finalObjectKey,
      storage_slug: "local"
    });
    assert.deepEqual(
      await fixture.localDriver.readBuffer("full", fixture.finalObjectKey),
      fixture.imageBody
    );
    assert.deepEqual(
      await fixture.localDriver.readBuffer("thumbs", fixture.finalThumbnailKey),
      fixture.thumbnailBody
    );
    await assert.rejects(access(ingestionPreparedPath(fixture.preparedImageFile)), { code: "ENOENT" });
    await assert.rejects(access(ingestionPreparedPath(fixture.preparedThumbnailFile)), { code: "ENOENT" });
    assert.equal(
      (await fixture.repository.readSession(
        fixture.owner,
        fixture.sessionId
      ))?.status,
      "completed"
    );
  });
});
