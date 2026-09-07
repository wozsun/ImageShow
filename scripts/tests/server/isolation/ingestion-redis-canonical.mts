import assert from "node:assert/strict";
import {
  runIntegrationScenario
} from "./integration-runtime.mts";
import {
  runWithReadyIngestionFixture
} from "./ingestion-fixture.mts";

await runIntegrationScenario(async (runtime) => {
  await runWithReadyIngestionFixture(runtime, "redis-canonical", async (fixture) => {
    const stored = await fixture.repository.readSession(
      fixture.owner,
      fixture.sessionId
    );
    assert.equal(stored?.status, "ready");
    assert.equal(stored?.image_id, fixture.imageId);
    const snapshot = await fixture.repository.snapshot(
      fixture.owner,
      "import",
      0,
      10
    );
    assert.deepEqual(snapshot.items.map((item) => item.session_id), [
      fixture.sessionId
    ]);
    assert.equal(
      await runtime.redisClient.redis.exists(fixture.repositoryKeys.canonical),
      1
    );
    assert.equal(
      await runtime.redisClient.redis.zscore(
        fixture.repositoryKeys.owner,
        fixture.sessionId
      ) !== null,
      true
    );
  });
});
