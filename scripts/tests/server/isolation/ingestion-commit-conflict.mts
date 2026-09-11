import assert from "node:assert/strict";
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
  await runWithReadyIngestionFixture(runtime, "commit-conflict", async (fixture) => {
    const committing = await freezeFixtureCommit(fixture);
    const foreignBody = Buffer.from(`foreign-object:${fixture.imageId}`);
    await fixture.driver.writeBuffer(
      "full",
      fixture.finalObjectKey,
      foreignBody,
      "image/webp"
    );
    await assert.rejects(
      commitWorker.commitIngestionSessionSnapshot(
        fixture.repository,
        new coordinatorModule.IngestionIrreversibleCoordinator(),
        committing as IngestionSessionSnapshot,
        new AbortController().signal
      ),
      (error: unknown) => (
        (error as { code?: unknown }).code === "storage_object_conflict"
      )
    );
    assert.deepEqual(
      await fixture.driver.readBuffer("full", fixture.finalObjectKey),
      foreignBody,
      "unowned formal bytes must remain untouched"
    );
    assert.equal(
      Number((await runtime.databasePools.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM metadata WHERE id=$1",
        [fixture.imageId]
      )).rows[0]?.count),
      0
    );
    assert.equal(
      Number((await runtime.databasePools.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM background_job WHERE target_id=$1",
        [fixture.imageId]
      )).rows[0]?.count),
      0,
      "a target rejected before copy must not acquire a cleanup guard"
    );
  });
});
