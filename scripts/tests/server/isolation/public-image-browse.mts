import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { neverAbortedSignal } from "../../../../packages/server/src/core/abort.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { interceptPoolConnections } from "./database-faults.mts";

await runIntegrationScenario(async (runtime) => {
  const { Hono } = await import("hono");
  const { registerPublicRoutes } = await import("../../../../packages/server/src/routes/public.ts");
  const { registerRandomRoutes } = await import("../../../../packages/server/src/routes/random.ts");
  const { selectRandomImages } =
    await import("../../../../packages/server/src/random/selection.ts");
  const { withPublicDatabaseRead } =
    await import("../../../../packages/server/src/core/database/public-fallback.ts");
  const { sampleReadyImagesFromPostgres } =
    await import("../../../../packages/server/src/random/postgres-selection.ts");
  const { sampleReadyImages } =
    await import("../../../../packages/server/src/images/ready-cache/query.ts");
  const { createImageFilterPlan } =
    await import("../../../../packages/server/src/images/filter-plan.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const reads = await import("../../../../packages/server/src/images/read-models/public-images.ts");
  const coordinator =
    await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");

  const { READY_IMAGE_ID_SUFFIX_LOOKUP_KEY } =
    await import("../../../../packages/server/src/images/ready-cache/keys.ts");
  const { readyImageMember } =
    await import("../../../../packages/server/src/images/ready-cache/model.ts");
  const { pool } = runtime.databasePools;
  const { redis } = runtime.redisClient;
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  registerPublicRoutes(app);
  registerRandomRoutes(app);
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
      `INSERT INTO metadata (id,created_by,status,storage_slug,device,brightness,theme,image_time,title,l_width,l_height,l_byte_size,l_md5,m_width,m_height,m_byte_size,m_md5,s_width,s_height,s_byte_size,s_md5) VALUES ($1,'integration-admin','ready','local','pc','dark',NULL,$3,$4,1600,900,GREATEST(1,1),$2,1600,900,GREATEST(1,1),$2,1600,900,GREATEST(1,1),$2)`,
      [
        id,
        createHash("md5").update(id).digest("hex"),
        `2026-09-01T00:00:00.00000${Math.floor(index / 2)}Z`,
        `Image ${index}`
      ]
    );
  }
  const time = Date.parse("2026-09-08T12:00:00Z");
  let now = time;
  const realNow = Date.now;
  Date.now = () => now;
  const get = (path: string, etag?: string) =>
    app.request(`http://imageshow.test${path}`, {
      headers: etag ? { "If-None-Match": etag } : {}
    });
  const sortedKeys = (value: object) => Object.keys(value).sort();
  const showKeys = ["id", "title", "base_url", "width", "height"].sort();
  const galleryKeys = [
    ...showKeys,
    "theme",
    "tags"
  ].sort();
  const expected = (order: "latest" | "oldest" | "random") => {
    if (order !== "random") {
      const result = [...ids].sort(
        (a, b) =>
          Math.floor(ids.indexOf(a) / 2) - Math.floor(ids.indexOf(b) / 2) || a.localeCompare(b)
      );
      return order === "latest" ? result.reverse() : result;
    }
    const cut = createHash("sha256").update("browse:2026-09-08").digest("hex").slice(0, 12);
    return [...ids].sort(
      (a, b) =>
        Number(a.slice(-12) < cut) - Number(b.slice(-12) < cut) ||
        a.slice(-12).localeCompare(b.slice(-12)) ||
        a.localeCompare(b)
    );
  };
  type Query = Parameters<typeof reads.listPublicImages>[0];
  const pages: Array<{ query: Query; value: Awaited<ReturnType<typeof reads.listPublicImages>> }> =
    [];
  const seedCases = ["wallpaper", "Wallpaper", " 图😀 ", "2026-09-15"];
  const selectRandom = (url: URL, userAgent = "", client = "") =>
    withPublicDatabaseRead(neverAbortedSignal, (database, signal) =>
      selectRandomImages(url, userAgent, client, signal, database)
    );
  const seeded = async (
    seed: string,
    filter = "device=all",
    client = "seed-client",
    mode = "json",
    limit?: number
  ) => {
    const result = await selectRandom(
      new URL(
        `http://imageshow.test/random?seed=${encodeURIComponent(seed)}&${filter}&mode=${mode}${limit === undefined ? "" : `&limit=${limit}`}`
      ),
      "Mozilla/5.0 (Windows NT 10.0)",
      client
    );
    assert.ok(!(result instanceof Response));
    assert.equal(result.items.length, Math.min(limit ?? 1, ids.length));
    return result.items.map((item) => item.id);
  };
  // A full id plus a suffix shared by two images: four requested candidates.
  const targetedIds = [ids[0]!, ids[2]!, ids[3]!, ids[4]!];
  const desktopAgent = "Mozilla/5.0 (Windows NT 10.0)";
  const mobileAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  const sorted = (values: string[]) => [...values].sort();
  const targeted = async (query: string, userAgent = desktopAgent, client = "") => {
    const result = await selectRandom(
      new URL(`http://imageshow.test/random?id=${ids[0]},${ids[2]},dddddddddddd&mode=json&${query}`),
      userAgent,
      client
    );
    assert.ok(!(result instanceof Response), query);
    return result.items.map((item) => item.id);
  };
  const coldSeeds = new Map<string, string[]>();
  const allPlan = createImageFilterPlan({});
  try {
    for (const seed of seedCases) {
      const batch = await seeded(seed, "device=all", "seed-client", "json", 200);
      assert.deepEqual([...batch].sort(), [...ids].sort());
      coldSeeds.set(seed, batch);
      for (const limit of [1, 3, 5]) {
        assert.deepEqual(
          await seeded(seed, "device=all", "seed-client", "json", limit),
          batch.slice(0, limit)
        );
      }
    }
    // Requested ids order by seed and image id only, so the cold PostgreSQL
    // result is the reference for the warm Redis path below.
    const targetedSeed = await targeted("seed=wallpaper&device=all&limit=200");
    assert.deepEqual(sorted(targetedSeed), sorted(targetedIds));
    for (const limit of [1, 3]) {
      assert.deepEqual(
        await targeted(`seed=wallpaper&device=all&limit=${limit}`),
        targetedSeed.slice(0, limit)
      );
    }
    // Explicit pivots exercise inclusive edges and UUID tie-breaking without
    // deriving the expected result from the seed hash implementation.
    for (const [start, expectedId] of [
      [0, ids[0]],
      [1, ids[0]],
      [0xdddddddddddd, ids[3]],
      [0xffffffffffff, ids[5]]
    ] as const) {
      const result = await sampleReadyImagesFromPostgres(
        allPlan,
        200,
        new Set(ids),
        pool,
        neverAbortedSignal,
        start
      );
      assert.deepEqual(
        result.map((item) => item.id),
        [...ids.slice(ids.indexOf(expectedId)), ...ids.slice(0, ids.indexOf(expectedId))]
      );
    }
    // Cold coordinator forces PostgreSQL; each cursor can cross view and size.
    for (const order of ["latest", "oldest", "random"] as const) {
      let cursor: string | undefined;
      const visited: string[] = [];
      do {
        const query = { status: "ready", view: "show", order, limit: 1, cursor } as const;
        const value = await reads.listPublicImages(query, new AbortController().signal, now);
        pages.push({ query, value });
        assert.deepEqual(sortedKeys(value.items[0]!), showKeys);
        visited.push(...value.items.map((item) => item.id));
        const galleryQuery = { ...query, view: "gallery" } as const;
        const gallery = await reads.listPublicImages(galleryQuery, neverAbortedSignal, now);
        assert.deepEqual(
          gallery.items.map((item) => item.id),
          value.items.map((item) => item.id)
        );
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
      assert.deepEqual(sortedKeys(body), ["base_urls", "items", "next_cursor", "ok"]);
      assert.deepEqual(
        body.items.map((item: { id: string }) => item.id),
        expected(order)
      );
      assert.equal(body.next_cursor, null);
      const etag = response.headers.get("etag")!.replace(/^W\//, "");
      for (const condition of [etag, `W/${etag}`, `"unrelated", ${etag}`, "*"]) {
        const validated = await get(path, condition);
        assert.equal(validated.status, 304);
        assert.equal(await validated.text(), "");
      }
    }
    for (const query of [
      "view=show&limit=0",
      "view=show&limit=801",
      "view=show&limit=x",
      "view=unknown&limit=1",
      "view=show",
      "limit=1"
    ]) {
      const response = await get(`/api/images?${query}`, "*");
      assert.equal(response.status, 400);
      assert.match(response.headers.get("cache-control")!, /no-store/);
    }
    const empty = await get("/api/images?view=show&limit=1&theme=unmatched");
    assert.deepEqual(await empty.json(), { ok: true, items: [], next_cursor: null });
    const detailPath = `/api/images/${ids[0]}?view=show`;
    await pool.query("UPDATE metadata SET device='mb' WHERE id=$1", [ids[0]]);
    const detail = await get(detailPath);
    const detailBody = await detail.json();
    for (const view of ["show", "gallery"] as const) {
      const path = `/api/images/${ids[0]}?view=${view}`;
      const response = await get(path);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.item.base_url, "/images");
      assert.equal(body.item.brightness, "dark");
      assert.equal(body.item.device, "mb", "横图详情保留人工选择的移动端分类");
      if (view === "show") {
        assert.equal(body.item.theme, null);
        assert.deepEqual(body.item.tags, []);
      }
      assert.equal((await get(path, response.headers.get("etag")!)).status, 304);
    }
    for (const query of ["", "?view=unknown", "?view=show&extra=1"]) {
      assert.equal((await get(`/api/images/${ids[0]}${query}`)).status, 400);
    }
    assert.equal(detailBody.item.source, null);
    const detailEtag = detail.headers.get("etag")!;
    const listPath = "/api/images?view=show&order=oldest&limit=1";
    const list = await get(listPath);
    await pool.query("UPDATE metadata SET title='Changed' WHERE id=$1", [ids[0]]);
    assert.equal((await get(listPath, list.headers.get("etag")!)).status, 200);
    assert.equal((await get(detailPath, detailEtag)).status, 304);
    await pool.query(
      "UPDATE metadata SET description='Detail changed', source='https://example.com/source' WHERE id=$1",
      [ids[0]]
    );
    assert.equal((await get(detailPath, detailEtag)).status, 200);
    await pool.query("UPDATE metadata SET status='deleted' WHERE id=$1", [ids[0]]);
    const missing = await get(detailPath, "*");
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("cache-control")!, /no-store/);
    await pool.query(
      "UPDATE metadata SET status='ready', title='Image 0', description='', source='' WHERE id=$1",
      [ids[0]]
    );

    // ids[0] is now portrait: requested ids follow the visitor's device like
    // any other request, without falling back to the other device.
    assert.deepEqual(await targeted("limit=200", mobileAgent), [ids[0]]);
    assert.deepEqual(sorted(await targeted("limit=200")), sorted(targetedIds.slice(1)));
    assert.deepEqual(sorted(await targeted("limit=200", "unrecognized-client")), sorted(targetedIds));
    assert.deepEqual(sorted(await targeted("device=all&limit=200", mobileAgent)), sorted(targetedIds));
    assert.deepEqual(
      await targeted("seed=wallpaper&limit=200", mobileAgent),
      [ids[0]],
      "seed orders only the candidates left by the device filter"
    );
    const noPortrait = await selectRandom(
      new URL(`http://imageshow.test/random?id=${ids[2]}`),
      mobileAgent
    );
    assert.ok(noPortrait instanceof Response);
    assert.equal(noPortrait.status, 404);

    await coordinator.initializeReadyImageCacheCoordinator();
    await coordinator.ensureReadyImageCacheCurrent({ signal: neverAbortedSignal });
    for (const view of ["show", "gallery"] as const) {
      assert.equal((await reads.getPublicImage(ids[0]!, view, neverAbortedSignal)).device, "mb");
    }
    await pool.query("UPDATE metadata SET device='pc' WHERE id=$1", [ids[0]]);
    await coordinator.requestReadyImageCacheRebuild({ signal: neverAbortedSignal });
    let connections = 0;
    const restoreConnections = interceptPoolConnections(pool, () => {
      connections += 1;
    });
    try {
      for (const { query, value } of pages) {
        assert.deepEqual(
          await reads.listPublicImages(query, new AbortController().signal, now),
          value
        );
      }
      assert.equal(connections, 0, "所有两档页与尾段碰撞均在热 Redis 命中");
      for (const seed of seedCases) {
        for (const mode of ["json", "redirect", "proxy"]) {
          assert.deepEqual(
            await seeded(seed, "device=all", "another-client", mode),
            coldSeeds.get(seed)!.slice(0, 1)
          );
        }
        for (const limit of [3, 5, 200]) {
          assert.deepEqual(
            await seeded(seed, "device=all", "another-client", "json", limit),
            coldSeeds.get(seed)!.slice(0, limit)
          );
        }
      }
      for (const [start, expectedId] of [
        [0, ids[0]],
        [1, ids[0]],
        [0xdddddddddddd, ids[3]],
        [0xffffffffffff, ids[5]]
      ] as const) {
        const result = await sampleReadyImages(allPlan, 200, new Set(ids), neverAbortedSignal, start);
        assert.ok(result.cached);
        assert.deepEqual(
          result.value.map((item) => item.id),
          [...ids.slice(ids.indexOf(expectedId)), ...ids.slice(0, ids.indexOf(expectedId))]
        );
      }
      assert.deepEqual(
        await targeted("seed=wallpaper&device=all&limit=200", desktopAgent, "another-client"),
        targetedSeed
      );
      assert.equal(connections, 0, "固定 seed 热路径与 PostgreSQL 冷路径选图相同且不查询数据库");
    } finally {
      restoreConnections();
    }

    const desktop = await seeded("wallpaper", "device=pc&brightness=dark&theme=null", "seed-client", "json", 5);
    assert.deepEqual(await seeded("wallpaper", "theme=null,null&brightness=DARK&device=auto", "seed-client", "json", 5), desktop);
    const emptySeed = await selectRandom(
      new URL("http://imageshow.test/random?seed=empty&device=mb")
    );
    assert.ok(emptySeed instanceof Response);
    assert.equal(emptySeed.status, 404);
    const recentBefore = await redis.keys("imageshow:random_recent:*");
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(await seeded("wallpaper", "device=all", "seed-client", "json", 5), coldSeeds.get("wallpaper")!.slice(0, 5));
      assert.deepEqual(
        await targeted("seed=wallpaper&device=all&limit=200", desktopAgent, "seed-client"),
        targetedSeed
      );
    }
    assert.deepEqual(
      await redis.keys("imageshow:random_recent:*"),
      recentBefore,
      "seed 不创建客户端近期历史"
    );
    const jsonSeed = await get("/random?device=all&seed=wallpaper&mode=json&limit=5");
    assert.equal(jsonSeed.status, 200);
    assert.match(jsonSeed.headers.get("cache-control")!, /no-store/);
    const seedBody = await jsonSeed.json();
    assert.equal(seedBody.count, 5);
    assert.deepEqual(
      seedBody.items.map((item: { id: string }) => item.id),
      coldSeeds.get("wallpaper")!.slice(0, 5)
    );
    const redirected = await get("/random?seed=wallpaper&mode=redirect&device=all");
    assert.equal(redirected.status, 302);
    assert.ok(redirected.headers.get("location")?.includes(coldSeeds.get("wallpaper")![0]!));
    // Without a seed, requested ids first avoid the client's recent images and
    // reuse them only when nothing else is left.
    const recentPick = async (search: string) => {
      const result = await selectRandom(
        new URL(`http://imageshow.test/random?${search}&device=all`),
        desktopAgent,
        "recent-client"
      );
      assert.ok(!(result instanceof Response), search);
      return result.items.map((item) => item.id);
    };
    const firstPick = await recentPick(`id=${ids[1]},${ids[2]}`);
    const secondPick = await recentPick(`id=${ids[1]},${ids[2]}`);
    assert.deepEqual(sorted([...firstPick, ...secondPick]), sorted([ids[1]!, ids[2]!]));
    for (let i = 0; i < 3; i++) assert.deepEqual(await recentPick(`id=${ids[1]}`), [ids[1]]);
    assert.ok(
      (await redis.keys("imageshow:random_recent:*")).length > recentBefore.length,
      "不带 seed 的指定图片请求记录近期历史"
    );
    // Removing the tail forces wraparound; both stores must keep the same
    // membership and tie order after a rebuild and a candidate deletion.
    await pool.query("UPDATE metadata SET status='deleted' WHERE id=$1", [ids[5]]);
    await coordinator.requestReadyImageCacheRebuild({ signal: neverAbortedSignal });
    const wrappedPg = await sampleReadyImagesFromPostgres(
      allPlan,
      200,
      new Set(ids),
      pool,
      neverAbortedSignal,
      0xffffffffffff
    );
    const wrappedRedis = await sampleReadyImages(
      allPlan,
      200,
      new Set(ids),
      neverAbortedSignal,
      0xffffffffffff
    );
    assert.deepEqual(
      wrappedPg.map((item) => item.id),
      ids.slice(0, -1)
    );
    assert.ok(wrappedRedis.cached);
    assert.deepEqual(
      wrappedRedis.value.map((item) => item.id),
      ids.slice(0, -1)
    );
    await pool.query("UPDATE metadata SET status='ready' WHERE id=$1", [ids[5]]);
    await coordinator.requestReadyImageCacheRebuild({ signal: neverAbortedSignal });
    for (const seed of seedCases) {
      assert.deepEqual(await seeded(seed, "device=all", "seed-client", "json", 200), coldSeeds.get(seed));
    }

    // Each order preserves its value boundary after the anchor is removed.
    for (const order of ["latest", "oldest", "random"] as const) {
      const anchor = pages.find(
        (page) => page.query.order === order && page.query.view === "show"
      )!;
      await pool.query("UPDATE metadata SET status='deleted' WHERE id=$1", [
        anchor.value.items[0]!.id
      ]);
      await coordinator.requestReadyImageCacheRebuild({ signal: neverAbortedSignal });
      const continuation = await reads.listPublicImages(
        {
          ...anchor.query,
          limit: 800,
          view: "gallery",
          device: "pc",
          cursor: anchor.value.next_cursor!
        },
        neverAbortedSignal,
        now
      );
      assert.deepEqual(
        continuation.items.map((item) => item.id),
        expected(order).slice(1)
      );
      const filtered = await reads.listPublicImages(
        { ...anchor.query, device: "mb", cursor: anchor.value.next_cursor! },
        neverAbortedSignal,
        now
      );
      assert.deepEqual(filtered, { items: [], next_cursor: null });
      await pool.query("UPDATE metadata SET status='ready' WHERE id=$1", [
        anchor.value.items[0]!.id
      ]);
      await coordinator.requestReadyImageCacheRebuild({ signal: neverAbortedSignal });
    }
    const anchor = pages.find(
      (page) => page.query.order === "random" && page.query.view === "show"
    )!;

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
      await assert.rejects(reads.listPublicImages(anchor.query, cancelled.signal, now), {
        name: "AbortError"
      });
      assert.equal(coordinator.getReadyImageCacheCoordinatorStatus().readable, true);
    } finally {
      redis.sendCommand = originalSend;
    }
    await redis.zrem(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, readyImageMember(ids[0]!));
    const recovered = await reads.listPublicImages(
      { ...anchor.query, limit: 800 },
      neverAbortedSignal,
      now
    );
    assert.deepEqual(
      recovered.items.map((item) => item.id),
      expected("random"),
      "核心缺项有界回源，不能把缺项当作末页"
    );
    await coordinator.requestReadyImageCacheRebuild({ signal: neverAbortedSignal });

    now = Date.parse("2026-09-08T23:59:55Z");
    const late = await get("/api/images?view=show&order=random&limit=1");
    assert.equal(late.headers.get("cache-control"), "public, max-age=5, s-maxage=5");
    const lateBody = await late.json();
    now += 5_001;
    const expired = await get(
      `/api/images?view=gallery&order=random&limit=100&cursor=${lateBody.next_cursor}`,
      "*"
    );
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).code, "cursor_expired");
    assert.match(expired.headers.get("cache-control")!, /no-store/);
    const invalidBoundary = await get(
      `/api/images?view=show&order=oldest&limit=1&cursor=${lateBody.next_cursor}`
    );
    assert.equal(invalidBoundary.status, 400);
    assert.equal((await invalidBoundary.json()).code, "invalid_cursor");
  } finally {
    Date.now = realNow;
    await pool.query("DELETE FROM metadata WHERE id=ANY($1::uuid[])", [ids]);
  }
});
