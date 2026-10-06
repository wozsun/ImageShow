import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMaintenanceFixture } from "./storage-maintenance-fixture.mts";
import { createS3HttpFixture } from "../../support/s3-http-fixture.ts";
import { neverAbortedSignal } from "../../../../packages/server/src/core/abort.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { access, body, createImage } = await createMaintenanceFixture(runtime);
  const { repairStorageVariant } = await import("../../../../packages/server/src/checks/storage-variant-repair.ts");
  const { maintainStorageAndPurgeTasks } = await import("../../../../packages/server/src/checks/storage-maintenance.ts");
  const s3 = await createS3HttpFixture();
  try {
    await runtime.databasePools.pool.query("INSERT INTO storage_backend(slug,display_name,type,config) VALUES ('replica','Replica','s3',$1::jsonb)", [JSON.stringify({...s3.settings,capabilities:{content_md5:false}})]);
    runtime.storageRegistry.invalidateStorageBackendRegistry();
    const source = await runtime.storageRegistry.resolveStorageAccess("replica");
    const image = await createImage({source:false});
    const before = (await runtime.databasePools.pool.query("SELECT * FROM metadata WHERE id=$1",[image.id])).rows[0];
    const signal = new AbortController().signal;
    for (const prefix of ["large","medium","small"] as const) {
      assert.equal((await repairStorageVariant(image.id,prefix,signal)).outcome,"failed","缺失时不能重新编码另一档冒充原文件");
      await source.driver.writeBuffer(prefix,image.key,Buffer.from("corrupt"),"image/webp");
      assert.equal((await repairStorageVariant(image.id,prefix,signal)).outcome,"failed");
      assert.equal(await access.driver.exists(prefix,image.key),false);
      await source.driver.removeObjects([{prefix,key:image.key}]);
      await source.driver.writeBuffer(prefix,image.key,body,"image/webp");
      assert.equal((await repairStorageVariant(image.id,prefix,signal)).outcome,"repaired");
      assert.deepEqual(await access.driver.readBuffer(prefix,image.key),body);
      assert.equal((await repairStorageVariant(image.id,prefix,signal)).outcome,"skipped");
      assert.deepEqual(await source.driver.readBuffer(prefix,image.key),body,"保留来源副本");
    }
    assert.deepEqual((await runtime.databasePools.pool.query("SELECT * FROM metadata WHERE id=$1",[image.id])).rows[0],before);
    const stop=AbortSignal.abort(new Error("cancel repair"));
    await assert.rejects(repairStorageVariant(image.id,"small",stop),e=>e===stop.reason);

    // Matching readable bytes are not enough when durability confirmation fails.
    const confirm = access.driver.ensureDurable!.bind(access.driver);
    access.driver.ensureDurable = async () => { throw new Error("synthetic fsync failure"); };
    try {
      const result = await maintainStorageAndPurgeTasks(neverAbortedSignal);
      assert.ok(result.storage.items.some((item) => item.image_id === image.id && item.outcome === "failed"));
      for (const prefix of ["large", "medium", "small"] as const) {
        assert.deepEqual(await source.driver.readBuffer(prefix, image.key), body);
      }
    } finally {
      access.driver.ensureDurable = confirm;
    }
    await maintainStorageAndPurgeTasks(neverAbortedSignal);
    for (const prefix of ["large", "medium", "small"] as const) assert.equal(await source.driver.exists(prefix, image.key), false);

    // A failed publication must remain distinguishable from a healthy object
    // after the request is gone. A later maintenance run must re-prove the target.
    for (const target of [access, source]) {
      const replica = target === access ? source : access;
      for (const damagedPrefix of ["large", "medium", "small"] as const) {
        const current = await createImage({ source: false });
        await runtime.databasePools.pool.query("UPDATE metadata SET storage_slug=$2 WHERE id=$1", [current.id, target.config.slug]);
        for (const prefix of ["large", "medium", "small"] as const) {
          await replica.driver.writeBuffer(prefix, current.key, body, "image/webp");
          if (prefix !== damagedPrefix) await target.driver.writeBuffer(prefix, current.key, body, "image/webp");
        }
        const write = target.driver.writeStream.bind(target.driver);
        target.driver.writeStream = async (...args) => {
          await write(...args);
          if (args[0] === damagedPrefix && args[1] === current.key) {
            await target.driver.removeObjects([{ prefix: damagedPrefix, key: current.key }]);
            await target.driver.writeBuffer(damagedPrefix, current.key, Buffer.from("unconfirmed repair"), "image/webp");
          }
        };
        try {
          const first = await maintainStorageAndPurgeTasks(neverAbortedSignal);
          assert.ok(first.storage.items.some((item) => item.image_id === current.id && item.outcome === "failed"));
        } finally {
          target.driver.writeStream = write;
        }
        const retried = await maintainStorageAndPurgeTasks(neverAbortedSignal);
        assert.ok(retried.storage.items.some((item) => item.image_id === current.id && item.outcome === "failed"));
        assert.deepEqual(await replica.driver.readBuffer(damagedPrefix, current.key), body, "重复维护保留唯一健康来源");
        assert.equal((await runtime.databasePools.pool.query("SELECT id FROM metadata WHERE id=$1", [current.id])).rowCount, 1);
        // Explicit restoration of this test's damaged object allows replicas to retire.
        await target.driver.removeObjects([{ prefix: damagedPrefix, key: current.key }]);
        await target.driver.writeBuffer(damagedPrefix, current.key, body, "image/webp");
        await maintainStorageAndPurgeTasks(neverAbortedSignal);
        assert.deepEqual(await target.driver.readBuffer(damagedPrefix, current.key), body);
        for (const prefix of ["large", "medium", "small"] as const) {
          assert.equal(await replica.driver.exists(prefix, current.key), false);
        }
      }
    }

    for (const failure of ["unavailable", "incomplete"] as const) {
      const current = await createImage({ source: false });
      for (const prefix of ["large", "medium", "small"] as const) await source.driver.writeBuffer(prefix, current.key, body, "image/webp");
      const list = access.driver.listKeys.bind(access.driver);
      access.driver.listKeys = (prefix, options) => prefix === "medium"
        ? (async function* () {
            if (failure === "unavailable") throw new Error("target namespace unavailable");
            yield [];
            return { complete: false, count: 0, reason: "max_keys" as const };
          })()
        : list(prefix, options);
      try {
        const result = await maintainStorageAndPurgeTasks(neverAbortedSignal);
        assert.ok(result.storage.items.some((item) => item.action === "inspect_namespace" && item.outcome === "failed"));
        for (const prefix of ["large", "medium", "small"] as const) assert.deepEqual(await source.driver.readBuffer(prefix, current.key), body);
      } finally {
        access.driver.listKeys = list;
      }
      await maintainStorageAndPurgeTasks(neverAbortedSignal);
      for (const prefix of ["large", "medium", "small"] as const) {
        assert.deepEqual(await access.driver.readBuffer(prefix, current.key), body);
        assert.equal(await source.driver.exists(prefix, current.key), false);
      }
    }

    const purging = await createImage({ source: false });
    await access.driver.writeBuffer("medium", purging.key, body, "image/webp");
    for (const prefix of ["large", "medium", "small"] as const) await source.driver.writeBuffer(prefix, purging.key, body, "image/webp");
    await runtime.databasePools.pool.query("UPDATE metadata SET status='deleted',deleted_at=now() WHERE id=$1", [purging.id]);
    await runtime.databasePools.pool.query("INSERT INTO background_job(id,type,status,target_id,error) VALUES ($1,'trash.purge','failed',$2,'exhausted')", [randomUUID(), purging.id]);
    const maintenance = await maintainStorageAndPurgeTasks(neverAbortedSignal);
    assert.equal(maintenance.storage.items.some((item) => item.action === "repair_variant" && item.image_id === purging.id), false);
    assert.equal(await access.driver.exists("large", purging.key), false, "不补回已经永久删除的档位");
    assert.equal(await access.driver.exists("small", purging.key), false);
    assert.equal((await repairStorageVariant(purging.id, "large", signal)).outcome, "skipped");
    for (const prefix of ["large", "medium", "small"] as const) assert.deepEqual(await source.driver.readBuffer(prefix, purging.key), body);
    assert.equal((await runtime.databasePools.pool.query("SELECT status FROM background_job WHERE type='trash.purge' AND target_id=$1", [purging.id])).rows[0]?.status, "pending");

    // A disabled backend may be an externally synced backup: checks and maintenance
    // must neither list nor probe it, and must never treat its objects as orphans.
    const { checkStorage } = await import("../../../../packages/server/src/checks/storage-check.ts");
    const { buildStorageMaintenancePlan } = await import("../../../../packages/server/src/checks/storage-maintenance-plan.ts");
    const pool = runtime.databasePools.pool;
    const backup = await createImage({ source: false });
    await pool.query("UPDATE metadata SET storage_slug='replica' WHERE id=$1", [backup.id]);
    const stranded = await createImage({ source: false });
    for (const prefix of ["large", "medium", "small"] as const) {
      await source.driver.writeBuffer(prefix, backup.key, body, "image/webp");
      await source.driver.writeBuffer(prefix, stranded.key, body, "image/webp");
    }
    await pool.query("UPDATE storage_backend SET enabled=false WHERE slug='replica'");
    runtime.storageRegistry.invalidateStorageBackendRegistry();
    const listDisabled = source.driver.listKeys.bind(source.driver);
    const existsDisabled = source.driver.exists.bind(source.driver);
    let disabledRequests = 0;
    source.driver.listKeys = (prefix, options) => { disabledRequests += 1; return listDisabled(prefix, options); };
    source.driver.exists = (prefix, key, options) => { disabledRequests += 1; return existsDisabled(prefix, key, options); };
    try {
      const check = await checkStorage(signal);
      assert.equal(check.orphan_objects.some((item) => item.backend === "replica" || item.key === backup.key || item.key === stranded.key), false, "停用后端的对象不报游离");
      assert.equal(check.missing_objects.some((item) => item.id === backup.id), false, "停用后端上的图片不检查缺失");
      assert.equal(check.unavailable_backends.some((item) => item.backend === "replica"), false);
      const retainedOnReplica = Number((await pool.query<{ count: string }>("SELECT count(*) FROM metadata WHERE storage_slug='replica' AND status IN ('ready','deleted')")).rows[0]!.count);
      assert.deepEqual(check.disabled_backend_images, [{ backend: "replica", image_count: retainedOnReplica }]);
      const plan = await buildStorageMaintenancePlan(signal);
      assert.equal(plan.capturedGroups.some((captured) => captured.group.slugs.includes("replica")), false);
      assert.equal(plan.candidates.some((candidate) => (candidate.kind === "remove" && candidate.backend === "replica") || (candidate.kind === "repair" && candidate.imageId === backup.id)), false, "停用后端不产生删除或修复候选");
      await maintainStorageAndPurgeTasks(neverAbortedSignal);
      assert.equal((await repairStorageVariant(backup.id, "large", signal)).outcome, "skipped", "图片所在存储已停用时跳过维修");
      assert.equal((await repairStorageVariant(stranded.id, "large", signal)).outcome, "failed", "停用后端不作为维修来源");
      assert.equal(await access.driver.exists("large", stranded.key), false);
      assert.equal(disabledRequests, 0, "停用后端不产生存储请求");
    } finally {
      source.driver.listKeys = listDisabled;
      source.driver.exists = existsDisabled;
    }
    for (const prefix of ["large", "medium", "small"] as const) {
      assert.deepEqual(await source.driver.readBuffer(prefix, backup.key), body, "停用后端上的对象原样保留");
      assert.deepEqual(await source.driver.readBuffer(prefix, stranded.key), body);
    }

    // A disabled alias of an enabled namespace keeps its images referenced, but they are
    // neither checked for missing objects nor repaired.
    await pool.query("UPDATE storage_backend SET enabled=true WHERE slug='replica'");
    await pool.query("INSERT INTO storage_backend(slug,display_name,type,config,enabled) VALUES ('replica-alias','Replica alias','s3',$1::jsonb,false)", [JSON.stringify({...s3.settings,capabilities:{content_md5:false}})]);
    runtime.storageRegistry.invalidateStorageBackendRegistry();
    const aliased = await createImage({ source: false });
    await pool.query("UPDATE metadata SET storage_slug='replica-alias' WHERE id=$1", [aliased.id]);
    for (const prefix of ["large", "small"] as const) await source.driver.writeBuffer(prefix, aliased.key, body, "image/webp");
    const shared = await checkStorage(signal);
    assert.equal(shared.orphan_objects.some((item) => item.key === aliased.key), false, "停用别名登记的图片仍受引用保护");
    assert.equal(shared.missing_objects.some((item) => item.id === aliased.id), false, "停用别名上的图片不检查缺失");
    assert.equal(shared.unavailable_backends.some((item) => item.backend === "replica-alias"), false);
    assert.deepEqual(shared.disabled_backend_images, [{ backend: "replica-alias", image_count: 1 }]);
    const sharedPlan = await buildStorageMaintenancePlan(signal);
    assert.equal(sharedPlan.candidates.some((candidate) => (candidate.kind === "repair" && candidate.imageId === aliased.id) || (candidate.kind === "remove" && candidate.key === aliased.key)), false);
    await maintainStorageAndPurgeTasks(neverAbortedSignal);
    assert.equal(await source.driver.exists("medium", aliased.key), false, "不为停用别名补回缺档");
    for (const prefix of ["large", "small"] as const) assert.deepEqual(await source.driver.readBuffer(prefix, aliased.key), body);
  } finally {await s3.close();}
});
