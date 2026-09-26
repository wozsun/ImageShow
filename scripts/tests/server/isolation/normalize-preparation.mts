import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultPreparationProfile } from "@imageshow/shared/browser";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { createMaintenanceFixture } from "./storage-maintenance-fixture.mts";

await runIntegrationScenario(async (runtime) => {
  const { pool } = runtime.databasePools;
  const repository = await import("../../../../packages/server/src/images/preparation/repository.ts");
  const { controlPreparation, readPreparationStatus } = await import("../../../../packages/server/src/images/preparation/service.ts");
  const { cleanupBackgroundJobHistory } = await import("../../../../packages/server/src/jobs/repository.ts");
  const fixture = await createMaintenanceFixture(runtime);
  const images = await Promise.all(Array.from({ length: 3 }, () => fixture.createImage({ source: false })));
  for (const image of images) await pool.query("UPDATE metadata SET original=$2 WHERE id=$1", [image.id, `https://images.example.test/${image.id}.png`]);
  const run = await repository.durableTransaction((client) => repository.createPreparationRun(client, defaultPreparationProfile(), 2, 1));
  const jobToken = randomUUID();
  await pool.query("UPDATE background_job SET status='running',execution_token=$2 WHERE id=$1", [run.id, jobToken]);
  await repository.enumeratePreparation(run.id);
  assert.equal((await readPreparationStatus()).counts.pending, 3);
  assert.equal(await repository.claimPreparationRecord(run.id, randomUUID()), undefined);
  const first = await repository.claimPreparationRecord(run.id, jobToken);
  const second = await repository.claimPreparationRecord(run.id, jobToken);
  assert.ok(first && second);
  assert.equal(await repository.claimPreparationRecord(run.id, jobToken), undefined);
  const reduced = await controlPreparation({ action: "set-concurrency", revision: 1, concurrency: 1 });
  assert.equal(reduced.active.length, 2, "降低并发不撤销正在处理的图片");
  await assert.rejects(controlPreparation({ action: "stop", revision: 1 }), { code: "preparation_revision_conflict" });
  await repository.finishPreparationRecord(first, "generate", "interrupted");
  assert.equal((await readPreparationStatus()).completed_attempts, 0);
  assert.equal(await repository.claimPreparationRecord(run.id, jobToken), undefined);
  await repository.finishPreparationRecord(second, "generate", "ready");
  await repository.finishPreparationRecord(second, "generate", "ready");
  assert.equal((await readPreparationStatus()).completed_attempts, 1, "完成回执重放只计数一次");
  const stop = await controlPreparation({ action: "stop", revision: 2 });
  assert.equal(stop.desired_state, "stopped");
  assert.equal(await repository.claimPreparationRecord(run.id, jobToken), undefined);

  for (const boundary of [18, 100, 900]) {
    await repository.durableTransaction(async (client) => {
      const current = await repository.lockedRun(client, run.id);
      Object.assign(current.payload, { desired_state: "running", completed_attempts: boundary - 1,
        next_short: Math.ceil(boundary / 18) * 18, next_long: Math.ceil(boundary / 100) * 100, rest: null });
      await repository.saveRun(client, current);
      const row = (await repository.readRecord(run.id, first.image_id, client))!;
      row.state = "pending";
      row.data.counted = false;
      await repository.saveRecord(client, row);
    });
    const claim = await repository.claimPreparationRecord(run.id, jobToken);
    assert.ok(claim);
    await repository.finishPreparationRecord(claim, "generate", "ready");
    const status = await readPreparationStatus();
    assert.equal(status.completed_attempts, boundary);
    assert.ok(status.rest);
    const long = boundary % 100 === 0;
    assert.equal(status.rest.kind, long ? "long" : "short");
    assert.ok(status.rest.seconds >= (long ? 50 : 5) && status.rest.seconds <= (long ? 180 : 30));
    assert.equal(status.rest.deadline, null);
    assert.equal(await repository.claimPreparationRecord(run.id, jobToken), undefined);
  }

  await repository.durableTransaction(async (client) => {
    const current = await repository.lockedRun(client, run.id);
    current.payload.rest = { kind: "short", seconds: 5, deadline: new Date(Date.now() + 60_000).toISOString() };
    await repository.saveRun(client, current);
  });
  assert.equal(await repository.claimPreparationRecord(run.id, jobToken), undefined);
  await pool.query("UPDATE background_job SET payload=jsonb_set(payload,'{rest,deadline}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE id=$1", [run.id]);
  const pending = await repository.claimPreparationRecord(run.id, jobToken);
  assert.ok(pending);
  await repository.finishPreparationRecord(pending, "generate", "failed", "controlled failure");
  assert.equal((await repository.readRecord(run.id, pending.image_id))?.state, "pending");
  assert.equal(await repository.claimPreparationRecord(run.id, jobToken), undefined, "退避期限内不立即重领");
  for (let retry = 0; retry < 2; retry += 1) {
    await pool.query("UPDATE image_variant_preparation SET data=jsonb_set(data,'{next_retry_at}','null') WHERE run_id=$1 AND image_id=$2", [run.id, pending.image_id]);
    const claim = await repository.claimPreparationRecord(run.id, jobToken);
    assert.ok(claim);
    await repository.finishPreparationRecord(claim, "generate", "failed", "controlled failure");
  }
  assert.equal((await repository.readRecord(run.id, pending.image_id))?.state, "failed");
  assert.equal((await readPreparationStatus()).completed_attempts, 901);
  const beforeRetry = await readPreparationStatus();
  const retried = await controlPreparation({ action: "retry", revision: beforeRetry.revision });
  assert.equal(retried.counts.pending, 1);
  assert.equal(retried.completed_attempts, 901);

  const staleClaim = await repository.claimPreparationRecord(run.id, jobToken);
  assert.ok(staleClaim);
  await pool.query("UPDATE metadata SET original='https://images.example.test/replaced.png' WHERE id=$1", [staleClaim.image_id]);
  await repository.finishPreparationRecord(staleClaim, "generate", "ready");
  assert.notEqual((await repository.readRecord(run.id, staleClaim.image_id))?.state, "ready", "来源变化不得提交就绪回执");
  await pool.query("DELETE FROM metadata WHERE id=$1", [second.image_id]);
  await controlPreparation({ action: "reconcile", revision: retried.revision });
  await repository.enumeratePreparation(run.id);
  assert.equal((await repository.readRecord(run.id, second.image_id))?.state, "excluded");
  await pool.query("UPDATE background_job SET status='succeeded',updated_at=clock_timestamp()-interval '100 days' WHERE id=$1", [run.id]);
  await cleanupBackgroundJobHistory();
  assert.ok(await repository.latestPreparationRun(), "持久恢复清单不随通用任务历史回收");
});
