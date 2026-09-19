import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { pool } = runtime.databasePools;
  const { redis } = runtime.redisClient;
  const coordinator = await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
  const { probeRedisOperationalState } = await import("../../../../packages/server/src/core/runtime-availability.ts");
  const { createImageFilterPlan, resolveImageFilterPlan } = await import("../../../../packages/server/src/images/filter-plan.ts");
  const { resolveReadyImageFilterIndex } = await import("../../../../packages/server/src/images/ready-cache/indexes/filter.ts");
  const { resolveReadyImageAttributeIndex } = await import("../../../../packages/server/src/images/ready-cache/indexes/attribute.ts");
  const { clearReadyImageDisposableCaches } = await import("../../../../packages/server/src/images/ready-cache/derived/lifecycle.ts");
  const { READY_IMAGE_DERIVED_CACHE_POLICY: policy } = await import("../../../../packages/server/src/images/ready-cache/derived/policy.ts");
  const { READY_IMAGE_STATS_KEY, READY_IMAGE_DERIVED_REGISTRY_LRU_KEY, readyImageAttributeIndexKey } = await import("../../../../packages/server/src/images/ready-cache/keys.ts");
  const { sampleReadyImages } = await import("../../../../packages/server/src/images/ready-cache/query.ts");
  const { moveImagesToTrash, restoreImages } = await import("../../../../packages/server/src/images/trash-mutations.ts");
  const { updateImages } = await import("../../../../packages/server/src/images/image-update.ts");
  const { Hono } = await import("hono");
  const { registerRandomRoutes } = await import("../../../../packages/server/src/routes/random.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  registerRandomRoutes(app);
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: `00000000-0000-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
    device: i % 5 === 0 ? "mb" as const : "pc" as const,
    brightness: i % 2 === 0 ? "light" as const : "dark" as const,
    tagged: i % 3 === 0
  }));
  const ids = (values: readonly { id: string }[]) => values.map(({ id }) => id).sort();
  const pc = rows.filter(({ device }) => device === "pc");
  const mb = rows.filter(({ device }) => device === "mb");
  const pcPlan = createImageFilterPlan({ devices: ["pc"] });
  const mbPlan = createImageFilterPlan({ devices: ["mb"] });
  const lruTags = Array.from({ length: policy.maxResults }, (_, i) => `device-lru-${i}`);
  const read = async (query: string, expected: readonly { id: string }[], userAgent = "synthetic-unknown-agent") => {
    const response = await app.request(`http://images.example/random?mode=json&limit=200&${query}`, {
      headers: { "user-agent": userAgent }
    });
    assert.equal(response.status, expected.length ? 200 : 404, query);
    if (expected.length) {
      const body = await response.json() as { items: Array<{ id: string }> };
      assert.deepEqual(ids(body.items), ids(expected), query);
    }
  };
  try {
    await pool.query("INSERT INTO tag(slug,display_name) VALUES('device-selected','Device selected')");
    for (const [i, row] of rows.entries()) {
      await pool.query(`INSERT INTO metadata(id,status,storage_slug,device,brightness,ext,md5,image_time,created_by)
        VALUES($1,'ready','local',$2,$3,'webp',$4,$5,'integration-admin')`,
      [row.id, row.device, row.brightness, i.toString(16).padStart(32, "0"), new Date(1_700_000_000_000 + i)]);
      if (row.tagged) await pool.query("INSERT INTO image_tag(image_id,tag_slug) VALUES($1,'device-selected')", [row.id]);
    }
    await read("device=pc", pc);
    await read("device=mb", mb);
    await probeRedisOperationalState();
    assert.equal((await coordinator.initializeReadyImageCacheCoordinator()).readable, true);
    await clearReadyImageDisposableCaches();

    const concurrent = await Promise.all(Array.from({ length: 8 }, () => resolveReadyImageFilterIndex(pcPlan)));
    const first = concurrent[0];
    assert.ok(first);
    assert.equal(first.kind, "attribute");
    assert.equal(first.count, pc.length);
    assert.equal(first.key, readyImageAttributeIndexKey({ kind: "device", value: "pc" }));
    assert.ok(concurrent.every((index) => index?.instanceToken === first.instanceToken), "concurrent first reads share one published index");
    assert.equal(await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY), 1, "one device request retains one complete candidate set");
    assert.ok(first.metaKey);
    assert.ok(await redis.ttl(first.key) > policy.ttlSeconds - 5);
    await redis.expire(first.key, 30);
    await redis.expire(first.metaKey, 30);
    assert.equal((await resolveReadyImageFilterIndex(pcPlan))?.instanceToken, first.instanceToken);
    assert.ok(await redis.ttl(first.key) > policy.ttlSeconds - 5, "index hit renews sliding TTL");
    assert.ok(await redis.ttl(first.metaKey) > policy.ttlSeconds - 5, "metadata renews with the index");
    assert.equal((await resolveReadyImageFilterIndex(mbPlan))?.count, mb.length);

    for (const [query, expected, agent] of [
      ["device=pc", pc, "synthetic-unknown-agent"],
      ["device=mb", mb, "synthetic-unknown-agent"],
      ["device=all", rows, "synthetic-unknown-agent"],
      ["device=auto", pc, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
      ["", mb, "Mozilla/5.0 (Linux; Android 14; Mobile)"],
      ["device=auto", rows, "synthetic-unknown-agent"]
    ] as const) await read(query, expected, agent);
    const sampled = await sampleReadyImages(pcPlan, 200);
    assert.ok(sampled.cached);
    if (sampled.cached) assert.deepEqual(ids(sampled.value), ids(pc), "both brightness groups remain complete");

    const combined = await resolveImageFilterPlan({ device: "pc", tag: "device-selected" });
    assert.equal((await resolveReadyImageFilterIndex(combined))?.count, pc.filter(({ tagged }) => tagged).length);
    await read("device=pc&tag=device-selected", pc.filter(({ tagged }) => tagged));
    const axis = await resolveReadyImageFilterIndex(createImageFilterPlan({ devices: ["pc"], brightnesses: ["light"] }));
    assert.equal(axis?.key, readyImageAttributeIndexKey({ kind: "axis", device: "pc", brightness: "light" }));
    await read("device=pc&brightness=light", pc.filter(({ brightness }) => brightness === "light"));

    await redis.pexpire(first.key, 1);
    await redis.pexpire(first.metaKey, 1);
    await delay(10);
    const rebuilt = await resolveReadyImageFilterIndex(pcPlan);
    assert.equal(rebuilt?.count, pc.length);
    assert.notEqual(rebuilt?.instanceToken, first.instanceToken, "expired device index is rebuilt with new ownership");

    await clearReadyImageDisposableCaches();
    const beforeEviction = await resolveReadyImageFilterIndex(pcPlan);
    assert.ok(beforeEviction?.metaKey);
    await pool.query("INSERT INTO tag(slug,display_name) SELECT value,value FROM unnest($1::text[]) value", [lruTags]);
    const revision = coordinator.getReadyImageCacheCoordinatorStatus().meta!.appliedRevision;
    for (const tag of lruTags) {
      const key = readyImageAttributeIndexKey({ kind: "tag", value: tag });
      assert.equal((await resolveReadyImageAttributeIndex(key, revision))?.count, 0);
    }
    assert.equal(await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY), policy.maxResults);
    assert.equal(await redis.exists(beforeEviction.key, beforeEviction.metaKey), 0, "capacity eviction removes the oldest device result and metadata together");
    const afterEviction = await resolveReadyImageFilterIndex(pcPlan);
    assert.equal(afterEviction?.count, pc.length);
    assert.notEqual(afterEviction?.instanceToken, beforeEviction.instanceToken);
    await read("device=pc", pc);
    await clearReadyImageDisposableCaches();

    const changed = pc[0]!;
    assert.equal((await moveImagesToTrash([changed.id])).trashed, 1);
    assert.equal((await resolveReadyImageFilterIndex(pcPlan))?.count, pc.length - 1);
    await read("device=pc", pc.filter(({ id }) => id !== changed.id));
    assert.equal((await restoreImages([changed.id])).restored, 1);
    assert.equal((await resolveReadyImageFilterIndex(pcPlan))?.count, pc.length);
    assert.equal((await updateImages([{ id: changed.id, device: "mb" }])).updated, 1);
    assert.equal((await resolveReadyImageFilterIndex(pcPlan))?.count, pc.length - 1);
    assert.equal((await resolveReadyImageFilterIndex(mbPlan))?.count, mb.length + 1);
    await read("device=mb", [...mb, changed]);

    await clearReadyImageDisposableCaches();
    const originalCount = await redis.hget(READY_IMAGE_STATS_KEY, "device:pc");
    // Model an over-cap core count without retaining a large permanent fixture.
    await redis.hset(READY_IMAGE_STATS_KEY, "device:pc", String(policy.maxResultMembers + 1));
    const originalConnect = pool.connect;
    let databaseConnections = 0;
    pool.connect = ((...args: never[]) => {
      databaseConnections += 1;
      return Reflect.apply(originalConnect, pool, args);
    }) as typeof pool.connect;
    try {
      assert.equal(await resolveReadyImageFilterIndex(pcPlan), null);
      assert.equal(databaseConnections, 0, "known over-cap index falls back before SQL or temporary materialization");
      assert.equal(await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY), 0);
    } finally {
      pool.connect = originalConnect;
      await redis.hset(READY_IMAGE_STATS_KEY, "device:pc", originalCount!);
    }
    const cancelled = AbortSignal.abort(new Error("synthetic cancellation"));
    await assert.rejects(resolveReadyImageFilterIndex(pcPlan, cancelled), /synthetic cancellation/);
    assert.equal((await resolveReadyImageFilterIndex(pcPlan))?.count, pc.length - 1);

    await pool.query("UPDATE metadata SET device='mb' WHERE id=ANY($1::uuid[])", [ids(rows)]);
    await pool.query("UPDATE ready_image_revision SET revision=revision+1 WHERE singleton=1");
    await coordinator.requestReadyImageCacheRebuild();
    assert.equal((await resolveReadyImageFilterIndex(pcPlan))?.count, 0);
    await read("device=pc", []);
    await read("device=mb", rows);
    console.log(JSON.stringify({ device_index_contracts: "passed", synthetic_rows: rows.length }));
  } finally {
    await coordinator.stopReadyImageCacheCoordinator();
    await pool.query("DELETE FROM metadata WHERE id=ANY($1::uuid[])", [ids(rows)]);
    await pool.query("DELETE FROM tag WHERE slug='device-selected'");
    await pool.query("DELETE FROM tag WHERE slug=ANY($1::text[])", [lruTags]);
  }
});
