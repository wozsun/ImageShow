import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { parseTagFilter } from "../../../../packages/shared/src/browser/tag-filter.ts";

await runIntegrationScenario(async (runtime) => {
  const { Hono } = await import("hono");
  const { registerPublicRoutes } = await import("../../../../packages/server/src/routes/public.ts");
  const { registerRandomRoutes } = await import("../../../../packages/server/src/routes/random.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const { storageObjectKey } = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
  const coordinator = await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
  const { resolveImageFilterPlan, createImageFilterPlan } = await import("../../../../packages/server/src/images/filter-plan.ts");
  const { sampleReadyImages, readReadyImageCursorPage } = await import("../../../../packages/server/src/images/ready-cache/query.ts");
  const { createImageBrowseContext } = await import("../../../../packages/server/src/images/cursor.ts");
  const vocab = await import("../../../../packages/server/src/vocab/vocab-cache.ts");
  const { listAdminImages } = await import("../../../../packages/server/src/images/read-models/admin-images.ts");
  const { updateImages } = await import("../../../../packages/server/src/images/image-update.ts");
  const { moveImagesToTrash, restoreImages } = await import("../../../../packages/server/src/images/trash-mutations.ts");
  const { pool } = runtime.databasePools;
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  registerPublicRoutes(app);
  registerRandomRoutes(app);
  const tags = ["matrix-a", "matrix-b", "matrix-c", "matrix-d"];
  const budgetTags = Array.from({ length: 9 }, (_, index) => `budget-${index}`);
  const allTags = [...tags, "matrix-empty", "matrix-alias", "matrix-symbols", ...budgetTags];
  const rows = Array.from({ length: 64 }, (_, index) => ({
    id: randomUUID(), mask: Math.floor(index / 4),
    device: index % 4 < 2 ? "pc" : "mb",
    brightness: index % 2 ? "light" : "dark",
    theme: ["matrix-city", "matrix-nature", null][Math.floor(index / 3) % 3]!,
    author: ["matrix-alice", "matrix-bob", null][Math.floor(index / 5) % 3]!
  }));
  await pool.query("INSERT INTO theme(slug, display_name) VALUES ('matrix-city','城市'),('matrix-nature','自然')");
  await pool.query("INSERT INTO author(slug, display_name) VALUES ('matrix-alice','作者甲'),('matrix-bob','作者乙')");
  for (const [index, slug] of allTags.entries()) {
    await pool.query("INSERT INTO tag(slug, display_name) VALUES ($1,$2)",
      [slug, ["城市", "夜景", "雨景", "森林", "空标签", "matrix-a", "A&B+C#%"][index] ?? slug]);
  }
  for (const [index, row] of rows.entries()) {
    await pool.query(`INSERT INTO metadata(id, created_by, status, storage_slug, object_key,
      device, brightness, theme, author, ext, md5, width, height, title)
      VALUES ($1,'integration-admin','ready','local',$2,$3,$4,$5,$6,'webp',$7,800,600,$8)`,
    [row.id, storageObjectKey(row.id, "webp"), row.device, row.brightness, row.theme,
      row.author, createHash("md5").update(row.id).digest("hex"), `Matrix ${index}`]);
    const members = tags.filter((_tag, bit) => row.mask & (1 << bit));
    if (index === 0) members.push(...budgetTags);
    else if (index < budgetTags.length) members.push(budgetTags[index]!);
    if (index === 63) members.push("matrix-alias", "matrix-symbols");
    for (const tag of members) await pool.query("INSERT INTO image_tag(image_id,tag_slug) VALUES ($1,$2)", [row.id, tag]);
  }
  await vocab.refreshEntityVocabularies(["tag", "theme", "author"]);
  const get = (path: string) => app.request(`http://imageshow.test${path}`, { headers: { "cache-control": "no-cache" } });
  const ids = (items: Array<{ id: string }>) => items.map(item => item.id).sort();
  type Row = typeof rows[number];
  type Case = { tags: string[]; match: (row: Row) => boolean; mixed?: boolean; axis?: Record<string, string> };
  const cases: Case[] = [];
  for (let mask = 1; mask < 16; mask += 1) {
    const terms = tags.filter((_tag, bit) => mask & (1 << bit));
    cases.push({ tags: [terms.join(",")], match: row => Boolean(row.mask & mask) });
    cases.push({ tags: [`all:${terms.join(",")}`], match: row => (row.mask & mask) === mask });
  }
  cases.push(
    { tags: ["matrix-a", "matrix-b"], match: row => Boolean(row.mask & 3) },
    { tags: ["all:matrix-a,matrix-b", "all:matrix-b,matrix-a"], match: row => (row.mask & 3) === 3 },
    { tags: ["all:matrix-a,matrix-b", "matrix-c"], match: row => (row.mask & 3) === 3 || Boolean(row.mask & 4), mixed: true },
    { tags: ["all:matrix-a,matrix-b", "all:matrix-c,matrix-d"], match: row => (row.mask & 3) === 3 || (row.mask & 12) === 12, mixed: true },
    { tags: ["matrix-empty"], match: () => false },
    { tags: ["all:matrix-a,matrix-empty"], match: () => false },
    { tags: ["matrix-a,matrix-empty"], match: row => Boolean(row.mask & 1) },
    { tags: ["all:城市,matrix-a"], match: row => Boolean(row.mask & 1) },
    { tags: ["A&B+C#%"], match: row => row.id === rows[63]!.id }
  );
  for (const device of ["pc", "mb"]) for (const brightness of ["dark", "light"]) {
    cases.push({ tags: ["all:matrix-a,matrix-b"], axis: { device, brightness, theme: "!matrix-city", author: "matrix-alice,matrix-bob" },
      match: row => (row.mask & 3) === 3 && row.device === device && row.brightness === brightness
        && row.theme !== "matrix-city" && row.author !== null });
  }
  cases.push({ tags: ["matrix-a,matrix-b"], axis: { theme: "null", author: "!matrix-bob" },
    match: row => Boolean(row.mask & 3) && row.theme === null && row.author !== "matrix-bob" });
  try {
    for (const backend of ["PostgreSQL", "Redis"]) {
      if (backend === "Redis") {
        assert.equal((await coordinator.initializeReadyImageCacheCoordinator()).readable, true);
      }
      for (const entry of cases) {
        const query = new URLSearchParams(entry.axis);
        entry.tags.forEach(tag => query.append("tag", tag));
        const expected = ids(rows.filter(entry.match));
        const label = `${backend}: ${query}`;
        if (backend === "Redis") {
          const base = await resolveImageFilterPlan({ ...entry.axis, tag: entry.mixed ? undefined : entry.tags });
          const plan = entry.mixed ? createImageFilterPlan({
            devices: base.axes.map(axis => axis.device),
            brightnesses: base.axes.map(axis => axis.brightness),
            theme: base.theme, author: base.author,
            tag: parseTagFilter(entry.tags, "mixed").expression
          }) : base;
          let sampled = await sampleReadyImages(plan, 200);
          const deadline = Date.now() + 5_000;
          // Prior stats reads may still be publishing attribute indexes; require
          // a real Redis hit after that bounded warm-up, never accept fallback.
          while (!sampled.cached && Date.now() < deadline) {
            await delay(20);
            sampled = await sampleReadyImages(plan, 200);
          }
          assert.equal(sampled.cached, true, `${label}: random must hit Redis`);
          if (sampled.cached) assert.deepEqual(ids(sampled.value), expected, label);
          let page = await readReadyImageCursorPage(plan, 100, createImageBrowseContext("latest"));
          while (page.status === "fallback" && Date.now() < deadline) {
            await delay(20);
            page = await readReadyImageCursorPage(plan, 100, createImageBrowseContext("latest"));
          }
          assert.equal(page.status, "hit", `${label}: page must hit Redis`);
          if (page.status === "hit") assert.deepEqual(ids(page.value.items), expected, label);
        }
        const random = await get(`/random?device=all&mode=json&limit=200&${query}`.replace("device=all&", entry.axis?.device ? "" : "device=all&"));
        assert.equal(random.status, expected.length ? 200 : 404, label);
        assert.match(random.headers.get("cache-control")!, /no-store/, label);
        if (expected.length) {
          const body = await random.json();
          assert.equal(body.count, expected.length, label);
          assert.deepEqual(ids(body.items), expected, label);
        }
        for (const view of ["show", "gallery"]) {
          const response = await get(`/api/images?view=${view}&limit=800&${query}`);
          assert.equal(response.status, entry.mixed ? 400 : 200, label);
          if (!entry.mixed) assert.deepEqual(ids((await response.json()).items), expected, label);
        }
        const stats = await get(`/api/gallery-stats?${query}`);
        assert.equal(stats.status, entry.mixed ? 400 : 200, label);
        if (!entry.mixed) {
          assert.equal((await stats.json()).matching_images, expected.length, label);
          const admin = await listAdminImages({ status: "ready", page: 1, limit: 100, tag: entry.tags, ...entry.axis });
          assert.equal(admin.total, expected.length, label);
          assert.deepEqual(ids(admin.items), expected, label);
        }
      }
      for (const tag of ["matrix-missing", "matrix-a,matrix-missing", "all:matrix-a,matrix-missing"]) {
        for (const prefix of ["/api/images?view=show&limit=60", "/api/gallery-stats?", "/random?device=all&mode=json"]) {
          const response = await get(`${prefix}&tag=${tag}`);
          assert.equal(response.status, 404, `${backend}: unknown ${prefix} ${tag}`);
        }
      }
      const facets = await (await get("/api/gallery-facets")).json();
      assert.ok(facets.tags.some((tag: { slug: string }) => tag.slug === "matrix-empty"));
    }
    // All sources are real, warm Redis indexes. Legal expressions that exceed
    // the set-operation budget must preserve every branch through PostgreSQL.
    for (const slug of budgetTags) {
      const plan = await resolveImageFilterPlan({ tag: [slug] });
      const deadline = Date.now() + 5_000;
      let sampled = await sampleReadyImages(plan, 200);
      while (!sampled.cached && Date.now() < deadline) {
        await delay(20);
        sampled = await sampleReadyImages(plan, 200);
      }
      assert.equal(sampled.cached, true, `warm source ${slug}`);
    }
    for (const entry of [
      { tags: [budgetTags.join(",")], expected: rows.slice(0, 9) },
      { tags: [`all:${budgetTags.join(",")}`, "matrix-c"], expected: rows.filter((row, index) => index === 0 || Boolean(row.mask & 4)) }
    ]) {
      const base = await resolveImageFilterPlan({});
      const plan = createImageFilterPlan({
        devices: base.axes.map(axis => axis.device),
        brightnesses: base.axes.map(axis => axis.brightness),
        theme: base.theme, author: base.author,
        tag: parseTagFilter(entry.tags, "mixed").expression
      });
      assert.equal((await sampleReadyImages(plan, 200)).cached, false);
      const query = new URLSearchParams({ device: "all", mode: "json", limit: "200" });
      entry.tags.forEach(tag => query.append("tag", tag));
      const response = await get(`/random?${query}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(ids((await response.json()).items), ids(entry.expected));
    }
    // Warm derived intersections must follow real mutation boundaries immediately.
    const path = "/api/images?view=gallery&limit=800&tag=all:matrix-a,matrix-b";
    const changed = rows[0]!;
    const before = await get(path);
    assert.equal((await before.json()).items.length, 16);
    assert.equal((await updateImages([{ id: changed.id, tags: ["matrix-a", "matrix-b"] }])).updated, 1);
    assert.equal((await (await get(path)).json()).items.length, 17);
    assert.equal((await moveImagesToTrash([changed.id])).trashed, 1);
    assert.equal((await (await get(path)).json()).items.length, 16);
    assert.equal((await restoreImages([changed.id])).restored, 1);
    assert.equal((await (await get(path)).json()).items.length, 17);
    assert.equal((await updateImages([{ id: changed.id, tags: [] }])).updated, 1);
    assert.equal((await (await get(path)).json()).items.length, 16);
    console.log(JSON.stringify({ backends: 2, cases: cases.length, mutationTransitions: 4 }));
  } finally {
    await pool.query("DELETE FROM metadata WHERE id=ANY($1::uuid[])", [rows.map(row => row.id)]);
    await pool.query("DELETE FROM tag WHERE slug=ANY($1::text[])", [allTags]);
    await pool.query("DELETE FROM theme WHERE slug=ANY($1::text[])", [["matrix-city", "matrix-nature"]]);
    await pool.query("DELETE FROM author WHERE slug=ANY($1::text[])", [["matrix-alice", "matrix-bob"]]);
  }
});
