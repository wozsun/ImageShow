import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { interceptPoolConnections } from "./database-faults.mts";

await runIntegrationScenario(async (runtime) => {
  const { Hono } = await import("hono");
  const { registerPublicRoutes } = await import("../../../../packages/server/src/routes/public.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const reads = await import("../../../../packages/server/src/images/read-models/public-images.ts");
  const coordinator = await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
  const { storageObjectKey } = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
  const { READY_IMAGE_ID_SUFFIX_LOOKUP_KEY } = await import("../../../../packages/server/src/images/ready-cache/keys.ts");
  const { readyImageMember } = await import("../../../../packages/server/src/images/ready-cache/model.ts");
  const { pool } = runtime.databasePools;
  const { redis } = runtime.redisClient;
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  registerPublicRoutes(app);
  const ids = [
    "00000000-0000-7000-8000-000000000001",
    "00000000-0000-7001-8000-000000000001",
    "00000000-0000-7000-8000-222222222222",
    "00000000-0000-7000-8000-dddddddddddd",
    "00000000-0000-7001-8000-dddddddddddd",
    "00000000-0000-7000-8000-ffffffffffff"
  ];
  for (const [index, id] of ids.entries()) {
    await pool.query(
      `INSERT INTO metadata (id, created_by, status, storage_slug, object_key,
        device, brightness, theme, ext, md5, image_time, title, width, height)
       VALUES ($1, 'integration-admin', 'ready', 'local', $2, 'pc', 'dark', NULL,
         'webp', $3, $4, $5, 1600, 900)`,
      [id, storageObjectKey(id, "webp"), createHash("md5").update(id).digest("hex"),
        `2026-09-01T00:00:00.00000${Math.floor(index / 2)}Z`, `Image ${index}`]
    );
  }
  const time = Date.parse("2026-09-08T12:00:00Z");
  let now = time;
  const realNow = Date.now;
  Date.now = () => now;
  const get = (path: string, etag?: string) => app.request(`http://imageshow.test${path}`, {
    headers: etag ? { "If-None-Match": etag } : {}
  });
  const sortedKeys = (value: object) => Object.keys(value).sort();
  const showKeys = ["id", "title", "thumb_url", "width", "height"].sort();
  const galleryKeys = [...showKeys, "author", "device", "brightness", "theme", "tags", "image_time"].sort();
  const expected = (order: "latest" | "oldest" | "random") => {
    if (order !== "random") {
      const result = [...ids].sort((a, b) => Math.floor(ids.indexOf(a) / 2) - Math.floor(ids.indexOf(b) / 2) || a.localeCompare(b));
      return order === "latest" ? result.reverse() : result;
    }
    const cut = createHash("sha256").update("browse:2026-09-08").digest("hex").slice(0, 12);
    return [...ids].sort((a, b) => Number(a.slice(-12) < cut) - Number(b.slice(-12) < cut)
      || a.slice(-12).localeCompare(b.slice(-12)) || a.localeCompare(b));
  };
  type Query = Parameters<typeof reads.listPublicImages>[0];
  const pages: Array<{ query: Query; value: Awaited<ReturnType<typeof reads.listPublicImages>> }> = [];
  try {
    // Cold coordinator forces PostgreSQL; each cursor can cross view and size.
    for (const order of ["latest", "oldest", "random"] as const) {
      let cursor: string | undefined;
      const visited: string[] = [];
      do {
        const query = { status: "ready", view: "show", order, limit: 1, cursor } as const;
        const value = await reads.listPublicImages(query, new AbortController().signal, now);
        pages.push({ query, value });
        assert.deepEqual(sortedKeys(value.items[0]!), showKeys);
        visited.push(...value.items.map(item => item.id));
        const galleryQuery = { ...query, view: "gallery" } as const;
        const gallery = await reads.listPublicImages(galleryQuery, undefined, now);
        assert.deepEqual(gallery.items.map(item => item.id), value.items.map(item => item.id));
        assert.deepEqual(sortedKeys(gallery.items[0]!), galleryKeys);
        pages.push({ query: galleryQuery, value: gallery });
        if (value.next_cursor) assert.equal(value.next_cursor.length, order === "random" ? 26 : 31);
        cursor = value.next_cursor ?? undefined;
      } while (cursor);
      assert.deepEqual(visited, expected(order));
      const path = `/api/images?view=gallery&order=${order}&limit=800`;
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "public, max-age=30, s-maxage=60");
      const body = await response.json();
      assert.deepEqual(sortedKeys(body), ["items", "next_cursor", "ok"]);
      assert.deepEqual(body.items.map((item: { id: string }) => item.id), expected(order));
      assert.equal(body.next_cursor, null);
      const etag = response.headers.get("etag")!.replace(/^W\//, "");
      for (const condition of [etag, `W/${etag}`, `"unrelated", ${etag}`, "*"]) {
        const validated = await get(path, condition);
        assert.equal(validated.status, 304);
        assert.equal(await validated.text(), "");
      }
    }
    for (const query of ["view=show&limit=0", "view=show&limit=801", "view=show&limit=x", "view=unknown&limit=1", "view=show", "limit=1"]) {
      const response = await get(`/api/images?${query}`, "*");
      assert.equal(response.status, 400);
      assert.match(response.headers.get("cache-control")!, /no-store/);
    }
    const empty = await get("/api/images?view=show&limit=1&theme=unmatched");
    assert.deepEqual(await empty.json(), { ok: true, items: [], next_cursor: null });
    const detailPath = `/api/images/${ids[0]}`;
    const detail = await get(detailPath);
    const detailBody = await detail.json();
    assert.deepEqual(sortedKeys(detailBody.item), ["id", "author", "device", "brightness", "theme", "tags", "image_time", "description", "source", "object_url", "original_url"].sort());
    assert.equal(detailBody.item.source, null);
    assert.equal(detailBody.item.original_url, null);
    const detailEtag = detail.headers.get("etag")!;
    const listPath = "/api/images?view=show&order=oldest&limit=1";
    const list = await get(listPath);
    await pool.query("UPDATE metadata SET title='Changed' WHERE id=$1", [ids[0]]);
    assert.equal((await get(listPath, list.headers.get("etag")!)).status, 200);
    assert.equal((await get(detailPath, detailEtag)).status, 304);
    await pool.query("UPDATE metadata SET description='Detail changed', source='https://example.com/source' WHERE id=$1", [ids[0]]);
    assert.equal((await get(detailPath, detailEtag)).status, 200);
    await pool.query("UPDATE metadata SET status='deleted' WHERE id=$1", [ids[0]]);
    const missing = await get(detailPath, "*");
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("cache-control")!, /no-store/);
    await pool.query("UPDATE metadata SET status='ready', title='Image 0', description='', source='' WHERE id=$1", [ids[0]]);

    await coordinator.initializeReadyImageCacheCoordinator();
    await coordinator.ensureReadyImageCacheCurrent();
    let connections = 0;
    const restoreConnections = interceptPoolConnections(pool, () => { connections += 1; });
    try {
      for (const { query, value } of pages) {
        assert.deepEqual(await reads.listPublicImages(query, new AbortController().signal, now), value);
      }
      assert.equal(connections, 0, "所有两档页与尾段碰撞均在热 Redis 命中");
    } finally { restoreConnections(); }

    // Each order preserves its value boundary after the anchor is removed.
    for (const order of ["latest", "oldest", "random"] as const) {
      const anchor = pages.find(page => page.query.order === order && page.query.view === "show")!;
      await pool.query("UPDATE metadata SET status='deleted' WHERE id=$1", [anchor.value.items[0]!.id]);
      await coordinator.requestReadyImageCacheRebuild();
      const continuation = await reads.listPublicImages({ ...anchor.query, limit: 800,
        view: "gallery", device: "pc", cursor: anchor.value.next_cursor! }, undefined, now);
      assert.deepEqual(continuation.items.map(item => item.id), expected(order).slice(1));
      const filtered = await reads.listPublicImages({ ...anchor.query,
        device: "mb", cursor: anchor.value.next_cursor! }, undefined, now);
      assert.deepEqual(filtered, { items: [], next_cursor: null });
      await pool.query("UPDATE metadata SET status='ready' WHERE id=$1", [anchor.value.items[0]!.id]);
      await coordinator.requestReadyImageCacheRebuild();
    }
    const anchor = pages.find(page => page.query.order === "random" && page.query.view === "show")!;

    const cancelled = new AbortController();
    const originalSend = redis.sendCommand;
    redis.sendCommand = async function (command, ...args) {
      if (command.name === "zrange") {
        cancelled.abort(new DOMException("cancelled", "AbortError"));
        throw cancelled.signal.reason;
      }
      return originalSend.call(this, command, ...args);
    };
    try {
      await assert.rejects(reads.listPublicImages(anchor.query, cancelled.signal, now), { name: "AbortError" });
      assert.equal(coordinator.getReadyImageCacheCoordinatorStatus().readable, true);
    } finally { redis.sendCommand = originalSend; }
    await redis.zrem(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, readyImageMember(ids[0]!));
    const recovered = await reads.listPublicImages({ ...anchor.query, limit: 800 }, undefined, now);
    assert.deepEqual(recovered.items.map(item => item.id), expected("random"), "核心缺项有界回源，不能把缺项当作末页");
    await coordinator.requestReadyImageCacheRebuild();

    now = Date.parse("2026-09-08T23:59:55Z");
    const late = await get("/api/images?view=show&order=random&limit=1");
    assert.equal(late.headers.get("cache-control"), "public, max-age=5, s-maxage=5");
    const lateBody = await late.json();
    now += 5_001;
    const expired = await get(`/api/images?view=gallery&order=random&limit=100&cursor=${lateBody.next_cursor}`, "*");
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).code, "cursor_expired");
    assert.match(expired.headers.get("cache-control")!, /no-store/);
    const invalidBoundary = await get(`/api/images?view=show&order=oldest&limit=1&cursor=${lateBody.next_cursor}`);
    assert.equal(invalidBoundary.status, 400);
    assert.equal((await invalidBoundary.json()).code, "invalid_cursor");
  } finally {
    Date.now = realNow;
    await pool.query("DELETE FROM metadata WHERE id=ANY($1::uuid[])", [ids]);
  }
});
