import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { ingestionPreparedPath } from "../../../../packages/server/src/images/ingestion/raw/paths.ts";
import type { IngestionSessionSnapshot } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import { createS3HttpFixture } from "../../support/s3-http-fixture.ts";
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
  const s3 = await createS3HttpFixture();
  try {
  for (const capability of ["local", "supported", "unsupported", "unknown"] as const) {
  const storageSlug = capability === "local" ? "local" : `s3-${capability}`;
  if (capability !== "local") {
    await runtime.databasePools.pool.query(
      "INSERT INTO storage_backend(slug, display_name, type, config) VALUES ($1, $1, 's3', $2::jsonb)",
      [storageSlug, JSON.stringify({ ...s3.settings, ...(capability === "unknown" ? {} : {
        capabilities: { content_md5: capability === "supported" }
      }) })]
    );
    runtime.storageRegistry.invalidateStorageBackendRegistry();
  }
  s3.state.capability = capability === "supported" ? "enforced" : "unsupported";
  await runWithReadyIngestionFixture(runtime, `commit-${capability}`, async (fixture) => {
    const committing = await freezeFixtureCommit(fixture);
    s3.requests.length = 0;
    const item = await commitWorker.commitIngestionSessionSnapshot(
      fixture.repository,
      new coordinatorModule.IngestionIrreversibleCoordinator(),
      committing as IngestionSessionSnapshot,
      new AbortController().signal
    );
    assert.equal(item?.id, fixture.imageId);
    if (capability !== "local") {
      assert.deepEqual(Object.fromEntries(["HEAD", "PUT", "GET"].map((method) => [
        method, s3.requests.filter((request) => request.method === method).length
      ])), { HEAD: 2, PUT: 2, GET: capability === "supported" ? 0 : 2 });
      assert.equal(s3.requests.reduce((bytes, request) => bytes + (request.method === "PUT" ? request.body.length : 0), 0),
        fixture.imageBody.length + fixture.thumbnailBody.length);
    }
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
      storage_slug: storageSlug
    });
    assert.deepEqual(
      await fixture.driver.readBuffer("full", fixture.finalObjectKey),
      fixture.imageBody
    );
    assert.deepEqual(
      await fixture.driver.readBuffer("thumbs", fixture.finalThumbnailKey),
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
  }, storageSlug);
  }
  assert.equal(s3.objects.size, 0);
  } finally { await s3.close(); }
});
