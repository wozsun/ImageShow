import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { neverAbortedSignal } from "../../../../packages/server/src/core/abort.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { interceptPoolConnections } from "./database-faults.mts";
import { pollUntil } from "../../support/polling.ts";

await runIntegrationScenario(async (runtime) => {
  const { pool } = runtime.databasePools;
  const { redis } = runtime.redisClient;
  const coordinator =
    await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
  const { probeRedisOperationalState } =
    await import("../../../../packages/server/src/core/runtime-availability.ts");
  const { createImageFilterPlan, resolveImageFilterPlan } =
    await import("../../../../packages/server/src/images/filter-plan.ts");
  const { resolveReadyImageFilterIndex } =
    await import("../../../../packages/server/src/images/ready-cache/indexes/filter.ts");
  const { resolveReadyImageAttributeIndex } =
    await import("../../../../packages/server/src/images/ready-cache/indexes/attribute.ts");
  const { buildReadyImageAttributeIndex } =
    await import("../../../../packages/server/src/images/ready-cache/indexes/attribute-builder.ts");
  const { clearReadyImageDisposableCaches, discardReadyImageDerivedResult } =
    await import("../../../../packages/server/src/images/ready-cache/derived/lifecycle.ts");
  const { READY_IMAGE_DERIVED_CACHE_POLICY: policy } =
    await import("../../../../packages/server/src/images/ready-cache/derived/policy.ts");
  const {
    READY_IMAGE_STATS_KEY,
    READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
    readyImageAttributeIndexKey,
    readyImageFilterKey
  } = await import("../../../../packages/server/src/images/ready-cache/keys.ts");
  const { sampleReadyImages } =
    await import("../../../../packages/server/src/images/ready-cache/query.ts");
  const { moveImagesToTrash, restoreImages } =
    await import("../../../../packages/server/src/images/trash/mutations.ts");
  const { updateImages } = await import("../../../../packages/server/src/images/image-update.ts");
  const { Hono } = await import("hono");
  const { registerRandomRoutes } = await import("../../../../packages/server/src/routes/random.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  registerRandomRoutes(app);
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: `00000000-0000-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
    device: i % 5 === 0 ? ("mb" as const) : ("pc" as const),
    brightness: i % 2 === 0 ? ("light" as const) : ("dark" as const),
    tagged: i % 3 === 0
  }));
  const ids = (values: readonly { id: string }[]) => values.map(({ id }) => id).sort();
  const pc = rows.filter(({ device }) => device === "pc");
  const mb = rows.filter(({ device }) => device === "mb");
  const pcPlan = createImageFilterPlan({ devices: ["pc"] });
  const mbPlan = createImageFilterPlan({ devices: ["mb"] });
  const lruTags = Array.from({ length: policy.maxResults }, (_, i) => `device-lru-${i}`);
  // Requests never wait for derived builds; poll until the background queue publishes.
  const publishedIndex = (plan: typeof pcPlan) =>
    pollUntil(
      () => resolveReadyImageFilterIndex(plan, neverAbortedSignal),
      (index) => index !== null
    );
  const read = async (
    query: string,
    expected: readonly { id: string }[],
    userAgent = "synthetic-unknown-agent"
  ) => {
    const response = await app.request(
      `http://images.example/random?mode=json&limit=200&${query}`,
      {
        headers: { "user-agent": userAgent, Referer: "http://images.example/gallery" }
      }
    );
    assert.equal(response.status, expected.length ? 200 : 404, query);
    if (expected.length) {
      const body = (await response.json()) as { items: Array<{ id: string }> };
      assert.deepEqual(ids(body.items), ids(expected), query);
    }
  };
  let fallbackSeedIds: string[] | undefined;
  const verifyFallback = async (cacheReady: boolean) => {
    const first = rows[0]!;
    const request = (query: string, method = "GET") => app.request(
      `http://images.example/random?${query}`,
      { method, headers: { Referer: "http://images.example/gallery", "user-agent": "synthetic-unknown-agent" } }
    );
    const readOrdinary = async (query: string) => {
      const response = await request(`mode=json&${query}`);
      assert.equal(response.status, 200, query);
      return await response.json() as { fallback: string[]; items: { id: string }[] };
    };
    const seededQuery = "device=all&theme=missing&fallback=theme&seed=fallback-window&limit=7";
    const seeded = await readOrdinary(seededQuery);
    assert.deepEqual(seeded.fallback, ["theme"]);
    const orderedIds = seeded.items.map((item) => item.id);
    assert.equal(new Set(orderedIds).size, 7);
    if (fallbackSeedIds) assert.deepEqual(orderedIds, fallbackSeedIds, "Redis and PG keep the same seeded fallback order");
    else fallbackSeedIds = orderedIds;
    const prefix = await readOrdinary(seededQuery.replace("limit=7", "limit=3"));
    assert.deepEqual(prefix.items.map((item) => item.id), orderedIds.slice(0, 3));
    const reordered = await readOrdinary(seededQuery.replace("fallback=theme", "fallback=device,theme,device"));
    assert.deepEqual(reordered.items.map((item) => item.id), orderedIds);
    if (cacheReady) {
      let connections = 0;
      const restore = interceptPoolConnections(pool, () => { connections += 1; });
      try { await readOrdinary(seededQuery); }
      finally { restore(); }
      assert.equal(connections, 0, "warm fallback selection uses Redis rather than silently falling back to PG");
    }
    const intermediate = "device=pc&brightness=dark&theme=fallback-stage&fallback=device,brightness";
    const deviceFirst = await readOrdinary(intermediate);
    assert.deepEqual(deviceFirst.fallback, ["device"]);
    assert.deepEqual(deviceFirst.items.map((item) => item.id), [rows[5]!.id]);
    await runtime.runtimeConfigStore.updateRuntimeConfig({
      site: { random_fallback_order: ["brightness", "device", "author", "tag", "theme"] }
    });
    const brightnessFirst = await readOrdinary(intermediate);
    assert.deepEqual(brightnessFirst.fallback, ["brightness"]);
    assert.deepEqual(brightnessFirst.items.map((item) => item.id), [rows[2]!.id]);
    await runtime.runtimeConfigStore.updateRuntimeConfig({
      site: { random_fallback_order: ["device", "brightness", "author", "tag", "theme"] }
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recent = await readOrdinary("device=all&theme=fallback-stage&fallback=theme&limit=200");
      assert.deepEqual(recent.fallback, [], "all candidates being recent or below limit must not widen the theme");
      assert.deepEqual(ids(recent.items), ids([rows[2]!, rows[5]!]));
    }
    const pick = async (query: string, expected: string[]) => {
      const response = await request(`mode=json&id=${first.id}&seed=fallback-contract&${query}`);
      assert.equal(response.status, 200, query);
      const body = await response.json() as { fallback: string[]; items: { id: string }[] };
      assert.deepEqual(body.fallback, expected, query);
      assert.deepEqual(body.items.map((item) => item.id), [first.id]);
    };
    for (const [query, dimension] of [
      ["device=pc", "device"], ["brightness=dark", "brightness"],
      ["author=missing", "author"], ["tag=missing", "tag"], ["theme=missing", "theme"]
    ]) await pick(`${query}&fallback=${dimension}`, [dimension!]);
    await pick("device=all&brightness=light&fallback=all&limit=200", []);
    const combined = "device=pc&brightness=dark&author=missing&tag=missing&theme=missing&fallback=all";
    await pick(combined, ["device", "brightness", "author", "tag", "theme"]);
    await runtime.runtimeConfigStore.updateRuntimeConfig({
      site: { random_fallback_order: ["theme", "tag", "author", "brightness", "device"] }
    });
    await pick(combined, ["theme", "tag", "author", "brightness", "device"]);
    await runtime.runtimeConfigStore.updateRuntimeConfig({
      site: { random_fallback_order: ["device", "brightness", "author", "tag", "theme"] }
    });
    await pick("theme=missing&fallback=all", ["theme"]);
    for (const query of [
      `id=${first.id}&theme=missing,!null`, `id=${first.id}&author=missing,!null`,
      "id=00000000-0000-7000-8000-ffffffffffff"
    ]) assert.equal((await request(`mode=json&fallback=all&${query}`)).status, 404, query);
    const get = await request(`mode=json&id=${first.id}&theme=missing&fallback=theme&seed=head`);
    const head = await request(`mode=json&id=${first.id}&theme=missing&fallback=theme&seed=head`, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), get.headers.get("content-length"));
    assert.equal(await head.text(), "");
    assert.equal((await request(`mode=redirect&id=${first.id}&theme=missing&fallback=theme`)).status, 302);
  };
  try {
    await pool.query(
      "INSERT INTO tag(slug,display_name) VALUES('device-selected','Device selected')"
    );
    for (const [i, row] of rows.entries()) {
      await pool.query(
        `INSERT INTO metadata (id,status,storage_slug,device,brightness,image_time,created_by,l_width,l_height,l_byte_size,l_md5,m_width,m_height,m_byte_size,m_md5,s_width,s_height,s_byte_size,s_md5) VALUES ($1,'ready','local',$2,$3,$5,'integration-admin',1,1,GREATEST(1,1),$4,1,1,GREATEST(1,1),$4,1,1,GREATEST(1,1),$4)`,
        [
          row.id,
          row.device,
          row.brightness,
          i.toString(16).padStart(32, "0"),
          new Date(1_700_000_000_000 + i)
        ]
      );
      if (row.tagged)
        await pool.query("INSERT INTO image_tag(image_id,tag_slug) VALUES($1,'device-selected')", [
          row.id
        ]);
    }
    await pool.query("INSERT INTO theme(slug) VALUES('fallback-stage')");
    await pool.query("UPDATE metadata SET theme='fallback-stage' WHERE id = ANY($1::uuid[])", [[rows[2]!.id, rows[5]!.id]]);
    await verifyFallback(false);
    await read("device=pc", pc);
    await read("device=mb", mb);
    await probeRedisOperationalState();
    assert.equal((await coordinator.initializeReadyImageCacheCoordinator()).readable, true);
    await verifyFallback(true);
    // Finish indexes scheduled by the fallback requests before the independent
    // cold-build/connection-count assertions clear and rebuild their fixtures.
    for (const plan of [
      createImageFilterPlan({ brightnesses: ["dark"], theme: { include: ["fallback-stage"] } }),
      createImageFilterPlan({ devices: ["pc"], theme: { include: ["fallback-stage"] } }),
      createImageFilterPlan({ theme: { include: ["fallback-stage"] } })
    ]) await publishedIndex(plan);
    await clearReadyImageDisposableCaches();

    let buildConnections = 0;
    const restoreBuildConnections = interceptPoolConnections(pool, () => {
      buildConnections += 1;
    });
    let first: Awaited<ReturnType<typeof publishedIndex>>;
    try {
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => resolveReadyImageFilterIndex(pcPlan, neverAbortedSignal))
      );
      assert.ok(
        concurrent.every((index) => index === null),
        "first reads fall back instead of waiting for the attribute build"
      );
      first = await publishedIndex(pcPlan);
    } finally {
      restoreBuildConnections();
    }
    assert.equal(buildConnections, 1, "concurrent first reads share one background build");
    assert.ok(first);
    assert.equal(first.kind, "attribute");
    assert.equal(first.count, pc.length);
    assert.equal(first.key, readyImageAttributeIndexKey({ kind: "device", value: "pc" }));
    assert.equal(
      await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY),
      1,
      "concurrent first reads publish one complete candidate set"
    );
    assert.ok(first.metaKey);
    assert.ok((await redis.ttl(first.key)) > policy.ttlSeconds - 5);
    await redis.expire(first.key, 30);
    await redis.expire(first.metaKey, 30);
    assert.equal(
      (await resolveReadyImageFilterIndex(pcPlan, neverAbortedSignal))?.instanceToken,
      first.instanceToken
    );
    assert.ok((await redis.ttl(first.key)) <= 30, "a hit within the access interval is not re-registered");
    const realNow = Date.now;
    const afterInterval = realNow() + policy.accessRegistrationIntervalMs;
    Date.now = () => afterInterval;
    try {
      assert.equal(
        (await resolveReadyImageFilterIndex(pcPlan, neverAbortedSignal))?.instanceToken,
        first.instanceToken
      );
    } finally {
      Date.now = realNow;
    }
    assert.ok((await redis.ttl(first.key)) > policy.ttlSeconds - 5, "index hit renews sliding TTL");
    assert.ok(
      (await redis.ttl(first.metaKey)) > policy.ttlSeconds - 5,
      "metadata renews with the index"
    );
    assert.equal((await publishedIndex(mbPlan))?.count, mb.length);

    for (const [query, expected, agent] of [
      ["device=pc", pc, "synthetic-unknown-agent"],
      ["device=mb", mb, "synthetic-unknown-agent"],
      ["device=all", rows, "synthetic-unknown-agent"],
      ["device=auto", pc, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
      ["", mb, "Mozilla/5.0 (Linux; Android 14; Mobile)"],
      ["device=auto", rows, "synthetic-unknown-agent"]
    ] as const)
      await read(query, expected, agent);
    const sampled = await sampleReadyImages(pcPlan, 200, new Set(), neverAbortedSignal);
    assert.ok(sampled.cached);
    if (sampled.cached)
      assert.deepEqual(ids(sampled.value), ids(pc), "both brightness groups remain complete");

    const combined = await resolveImageFilterPlan({ device: "pc", tag: "device-selected" });
    assert.equal(
      (await publishedIndex(combined))?.count,
      pc.filter(({ tagged }) => tagged).length
    );
    await read(
      "device=pc&tag=device-selected",
      pc.filter(({ tagged }) => tagged)
    );

    // A visitor who leaves cancels only its own wait, not the build shared with others.
    await discardReadyImageDerivedResult(readyImageFilterKey(combined.signature), "filter");
    const sendCommand = redis.sendCommand;
    let setOperations = 0;
    let setOperationHeld!: () => void;
    const setOperationReached = new Promise<void>((resolve) => {
      setOperationHeld = resolve;
    });
    let releaseSetOperation!: () => void;
    const setOperationGate = new Promise<void>((resolve) => {
      releaseSetOperation = resolve;
    });
    redis.sendCommand = async function (command, ...args) {
      if (command.args.includes("ZINTERSTORE")) {
        setOperations += 1;
        setOperationHeld();
        await setOperationGate;
      }
      return sendCommand.call(this, command, ...args);
    };
    try {
      const leaving = new AbortController();
      const leavingVisitor = resolveReadyImageFilterIndex(combined, leaving.signal);
      const stayingVisitor = resolveReadyImageFilterIndex(combined, neverAbortedSignal);
      await Promise.race([
        setOperationReached,
        stayingVisitor.then(() => assert.fail("shared build must reach the set operation"))
      ]);
      leaving.abort(new Error("first visitor left"));
      releaseSetOperation();
      await assert.rejects(leavingVisitor, /first visitor left/);
      assert.equal((await stayingVisitor)?.count, pc.filter(({ tagged }) => tagged).length);
      assert.equal(setOperations, 1, "the staying visitor joined the shared build");
    } finally {
      releaseSetOperation();
      redis.sendCommand = sendCommand;
    }
    const axis = await publishedIndex(
      createImageFilterPlan({ devices: ["pc"], brightnesses: ["light"] })
    );
    assert.equal(
      axis?.key,
      readyImageAttributeIndexKey({ kind: "axis", device: "pc", brightness: "light" })
    );
    await read(
      "device=pc&brightness=light",
      pc.filter(({ brightness }) => brightness === "light")
    );

    await redis.pexpire(first.key, 1);
    await redis.pexpire(first.metaKey, 1);
    await delay(10);
    const rebuilt = await publishedIndex(pcPlan);
    assert.equal(rebuilt?.count, pc.length);
    assert.notEqual(
      rebuilt?.instanceToken,
      first.instanceToken,
      "expired device index is rebuilt with new ownership"
    );

    await clearReadyImageDisposableCaches();
    const beforeEviction = await publishedIndex(pcPlan);
    assert.ok(beforeEviction?.metaKey);
    await pool.query(
      "INSERT INTO tag(slug,display_name) SELECT value,value FROM unnest($1::text[]) value",
      [lruTags]
    );
    const revision = coordinator.getReadyImageCacheCoordinatorStatus().meta!.appliedRevision;
    for (const tag of lruTags) {
      const key = readyImageAttributeIndexKey({ kind: "tag", value: tag });
      const index = await pollUntil(
        () => resolveReadyImageAttributeIndex(key, revision, neverAbortedSignal),
        (resolved) => resolved !== null
      );
      assert.equal(index?.count, 0);
    }
    assert.equal(await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY), policy.maxResults);
    assert.equal(
      await redis.exists(beforeEviction.key, beforeEviction.metaKey),
      0,
      "capacity eviction removes the oldest device result and metadata together"
    );
    const afterEviction = await publishedIndex(pcPlan);
    assert.equal(afterEviction?.count, pc.length);
    assert.notEqual(afterEviction?.instanceToken, beforeEviction.instanceToken);
    await read("device=pc", pc);
    await clearReadyImageDisposableCaches();

    const changed = pc[0]!;
    assert.equal((await moveImagesToTrash([changed.id])).trashed, 1);
    assert.equal((await publishedIndex(pcPlan))?.count, pc.length - 1);
    await read(
      "device=pc",
      pc.filter(({ id }) => id !== changed.id)
    );
    assert.equal((await restoreImages([changed.id])).restored, 1);
    assert.equal((await publishedIndex(pcPlan))?.count, pc.length);
    assert.equal((await updateImages([{ id: changed.id, device: "mb" }])).updated, 1);
    assert.equal((await publishedIndex(pcPlan))?.count, pc.length - 1);
    assert.equal((await publishedIndex(mbPlan))?.count, mb.length + 1);
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
      assert.equal(await resolveReadyImageFilterIndex(pcPlan, neverAbortedSignal), null);
      const overCapRevision = coordinator.getReadyImageCacheCoordinatorStatus().meta!.appliedRevision;
      assert.equal(
        await buildReadyImageAttributeIndex({ kind: "device", value: "pc" }, overCapRevision),
        null
      );
      assert.equal(
        databaseConnections,
        0,
        "known over-cap index falls back before SQL or temporary materialization"
      );
      assert.equal(await redis.zcard(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY), 0);
    } finally {
      pool.connect = originalConnect;
      await redis.hset(READY_IMAGE_STATS_KEY, "device:pc", originalCount!);
    }
    const cancelled = AbortSignal.abort(new Error("synthetic cancellation"));
    await assert.rejects(resolveReadyImageFilterIndex(pcPlan, cancelled), /synthetic cancellation/);
    assert.equal((await publishedIndex(pcPlan))?.count, pc.length - 1);

    await pool.query("UPDATE metadata SET device='mb' WHERE id=ANY($1::uuid[])", [ids(rows)]);
    await pool.query("UPDATE projection_revision SET revision=revision+1 WHERE singleton=1");
    await coordinator.requestReadyImageCacheRebuild({ signal: neverAbortedSignal });
    assert.equal((await publishedIndex(pcPlan))?.count, 0);
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
