import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pollUntil } from "../../support/polling.ts";
import type { Hono as HonoApp } from "hono";
import type { AdminSession } from "../../../../packages/server/src/core/http/admin-session-context.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { pool } = runtime.databasePools;
  const groups = await import("../../../../packages/server/src/images/groups/mutations.ts");
  const { listImageGroups } = await import("../../../../packages/server/src/images/groups/queries.ts");
  const { listAdminImages, getAdminImageSnapshots } = await import("../../../../packages/server/src/images/read-models/admin-images.ts");
  const trash = await import("../../../../packages/server/src/images/trash/mutations.ts");
  const { requireOperationalRedis } = await import("../../../../packages/server/src/core/runtime-availability.ts");
  await requireOperationalRedis();
  const [first, second, missing] = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of [first, second]) {
    await pool.query(
      `INSERT INTO metadata(id,created_by,storage_slug,device,brightness,
         l_width,l_height,l_byte_size,l_md5,m_width,m_height,m_byte_size,m_md5,s_width,s_height,s_byte_size,s_md5)
       VALUES($1,'integration-admin','local','pc','dark',1,1,1,$2,1,1,1,$2,1,1,1,$2)`,
      [id, "a".repeat(32)]
    );
  }
  const revision = async () => (await pool.query("SELECT revision::text FROM projection_revision")).rows[0].revision;
  const initialRevision = await revision();
  await groups.createImageGroup("first", "第一组");
  await groups.renameImageGroup("first", "修改名称");
  assert.equal(await revision(), initialRevision, "empty group and display name do not change projection");
  await assert.rejects(groups.createImageGroup("first", ""), /分组已存在/);
  const added = await groups.addImageGroupMembers("first", [first.toUpperCase(), first, "bad", missing]);
  assert.deepEqual(added.items.map((item) => item.status), ["added", "already_member", "invalid_id", "not_found"]);
  assert.equal(BigInt(await revision()), BigInt(initialRevision) + 1n);
  assert.deepEqual(await listImageGroups(), [{ slug: "first", display_name: "修改名称", sort_order: 0, image_count: 1 }]);
  const scoped = await listAdminImages({ status: "ready", group: "first", page: 1, limit: 50 });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.items[0]!.id, first);
  const marked = await listAdminImages({ status: "ready", mark_group: "first", page: 1, limit: 50 });
  assert.equal(marked.total, 2);
  assert.equal(marked.items.find((item) => item.id === first)!.in_group, true);
  assert.equal(marked.items.find((item) => item.id === second)!.in_group, false);
  const inputSnapshots = await getAdminImageSnapshots([first, second, missing], new AbortController().signal, "first");
  assert.deepEqual(inputSnapshots.items.map(({ id, in_group }) => ({ id, in_group })), [
    { id: first, in_group: true }, { id: second, in_group: false }
  ]);
  // A proxy can lose the response while the original write is still blocked.
  // Both member and picker snapshots must wait for that write, not cache its old state.
  const blocker = await pool.connect();
  let pendingWrite: Promise<unknown> | undefined;
  let pendingReads: Promise<unknown>[] = [];
  try {
    await blocker.query("BEGIN");
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await blocker.query("SELECT id FROM metadata WHERE id=$1 FOR UPDATE", [second]);
    pendingWrite = groups.addImageGroupMembers("first", [second]);
    assert.equal(await pollUntil(
      async () => (await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked",
        [blockerPid]
      )).rows[0].blocked as boolean,
      (blocked) => blocked
    ), true, "the original membership write is blocked inside its transaction");
    const membersAfterWrite = listAdminImages({ status: "ready", group: "first", page: 1, limit: 50 });
    const pickerAfterWrite = listAdminImages({ status: "ready", mark_group: "first", page: 1, limit: 50 });
    const inputAfterWrite = getAdminImageSnapshots([second], new AbortController().signal, "first");
    pendingReads = [membersAfterWrite, pickerAfterWrite, inputAfterWrite];
    let readsSettled = 0;
    void membersAfterWrite.then(() => { readsSettled += 1; }, () => undefined);
    void pickerAfterWrite.then(() => { readsSettled += 1; }, () => undefined);
    void inputAfterWrite.then(() => { readsSettled += 1; }, () => undefined);
    assert.ok((await pollUntil(
      async () => Number((await pool.query(
        "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted"
      )).rows[0].waiting),
      (waiting) => waiting >= 3
    )) >= 3, "list and ID snapshots must wait for membership writes");
    assert.equal(readsSettled, 0, "membership snapshots wait outside their read transaction");
    await blocker.query("COMMIT");
    await pendingWrite;
    const [members, picker, input] = await Promise.all([membersAfterWrite, pickerAfterWrite, inputAfterWrite]);
    assert.equal(members.total, 2);
    assert.ok(members.items.some((item) => item.id === second));
    assert.equal(picker.items.find((item) => item.id === second)!.in_group, true);
    assert.equal(input.items[0]!.in_group, true);
    assert.equal((await listImageGroups())[0]!.image_count, 2);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await Promise.allSettled([...(pendingWrite ? [pendingWrite] : []), ...pendingReads]);
  }
  await groups.removeImageGroupMembers("first", [second]);
  // Reverse group/mark_group combinations acquire the same sorted lock order.
  const orderBlocker = await pool.connect();
  const orderKeys = ["imageshow:image-group:first", "imageshow:image-group:second"];
  let reverseReads: Promise<unknown>[] = [];
  try {
    for (const key of orderKeys) await orderBlocker.query("SELECT pg_advisory_lock_shared(hashtext($1))", [key]);
    const forward = listAdminImages({ status: "ready", group: "first", mark_group: "second", page: 1, limit: 50 });
    const reverse = listAdminImages({ status: "ready", group: "second", mark_group: "first", page: 1, limit: 50 });
    reverseReads = [forward, reverse];
    void Promise.allSettled(reverseReads);
    assert.ok((await pollUntil(
      async () => Number((await pool.query(
        "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted"
      )).rows[0].waiting),
      (waiting) => waiting >= 2
    )) >= 2);
    await orderBlocker.query("SELECT pg_advisory_unlock_shared(hashtext($1))", [orderKeys[0]]);
    assert.equal(await pollUntil(
      async () => (await pool.query(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock'
          AND granted AND objid=(hashtext($1)::bigint & 4294967295)::oid) AS acquired`,
        [orderKeys[0]]
      )).rows[0].acquired as boolean,
      (acquired) => acquired
    ), true);
    await orderBlocker.query("SELECT pg_advisory_unlock_shared(hashtext($1))", [orderKeys[1]]);
    const [forwardResult, reverseResult] = await Promise.all([forward, reverse]);
    assert.equal(forwardResult.total, 1);
    assert.equal(forwardResult.items[0]!.in_group, false);
    assert.equal(reverseResult.total, 0);
  } finally {
    await orderBlocker.query("SELECT pg_advisory_unlock_all()");
    orderBlocker.release();
    await Promise.allSettled(reverseReads);
  }
  await trash.moveImagesToTrash([first]);
  assert.equal((await listImageGroups())[0]!.image_count, 0);
  assert.equal((await groups.addImageGroupMembers("first", [first])).items[0]!.status, "not_found");
  assert.equal((await pool.query("SELECT * FROM image_group_member")).rowCount, 1, "trash retains membership");
  await trash.restoreImages([first]);
  assert.equal((await listImageGroups())[0]!.image_count, 1);
  // Two concurrent joins compete for one remaining membership; both cannot win.
  await pool.query("INSERT INTO image_group(slug) SELECT 'limit-' || n FROM generate_series(1,51) n");
  await pool.query("INSERT INTO image_group_member SELECT 'limit-' || n, $1::uuid FROM generate_series(1,48) n", [first]);
  const competing = await Promise.all([
    groups.addImageGroupMembers("limit-49", [first]),
    groups.addImageGroupMembers("limit-50", [first])
  ]);
  assert.deepEqual(competing.map((result) => result.items[0]!.status).sort(), ["added", "group_limit"]);
  const mixed = await groups.addImageGroupMembers("limit-51", [first, second]);
  assert.deepEqual(mixed.items.map((item) => item.status), ["group_limit", "added"]);
  assert.equal((await pool.query("SELECT count(*)::int n FROM image_group_member WHERE image_id=$1", [first])).rows[0].n, 50);
  const beforeRemove = await revision();
  assert.deepEqual(await groups.removeImageGroupMembers("first", [first]), { removed: 1 });
  assert.equal(BigInt(await revision()), BigInt(beforeRemove) + 1n);
  assert.deepEqual(await groups.removeImageGroupMembers("first", [first]), { removed: 0 });
  assert.equal(BigInt(await revision()), BigInt(beforeRemove) + 1n);
  await groups.deleteImageGroup("limit-51");
  assert.equal((await pool.query("SELECT * FROM image_group_member WHERE group_slug='limit-51'")).rowCount, 0);
  // Physical image deletion, unlike trash, removes all memberships by FK.
  await pool.query("DELETE FROM metadata WHERE id=$1", [first]);
  assert.equal((await pool.query("SELECT * FROM image_group_member WHERE image_id=$1", [first])).rowCount, 0);

  const { Hono } = await import("hono");
  const { ApiError } = await import("../../../../packages/server/src/core/api-error.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const { requireAdminCsrf } = await import("../../../../packages/server/src/users/admin-session.ts");
  const { registerAdminGroupRoutes } = await import("../../../../packages/server/src/routes/admin-groups.ts");
  const app = new Hono<{ Variables: { session: AdminSession } }>();
  app.onError((error, c) => handleApiError(c, error));
  app.use("/api/admin/*", async (c, next) => {
    const role = c.req.header("x-test-role");
    if (role !== "super" && role !== "image") throw new ApiError(401, "unauthorized", "Authentication required");
    c.set("session", { id: "group-test", username: "integration-admin", role, csrf: "group-test-csrf" });
    if (c.req.method !== "GET") return requireAdminCsrf(c, next);
    await next();
  });
  registerAdminGroupRoutes(app as unknown as HonoApp);
  const request = (path: string, body?: unknown, role = "image", csrf = "group-test-csrf") => app.request(
    `http://imageshow.test/api/admin/groups${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-test-role": role, "x-csrf-token": csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }
  );
  assert.equal((await request("", undefined, "")).status, 401);
  assert.equal((await request("", { slug: "http" }, "image", "")).status, 403);
  assert.equal((await request("", { slug: "http", display_name: "HTTP" })).status, 200);
  assert.equal((await request("/http", { display_name: "renamed" })).status, 200);
  const beforeSort = await revision();
  assert.equal((await request("/http/sort-order", { sort_order: 42 })).status, 200);
  assert.equal((await listImageGroups())[0]!.slug, "http");
  assert.equal((await listImageGroups())[0]!.sort_order, 42);
  assert.equal((await request("/http/sort-order", { sort_order: -42 })).status, 200);
  assert.equal((await listImageGroups()).at(-1)!.slug, "http", "negative priorities follow zero");
  assert.equal((await request("/http/sort-order", { sort_order: 0 })).status, 200);
  assert.equal((await listImageGroups())[0]!.slug, "http", "equal priorities put newly created groups first");
  assert.equal(await revision(), beforeSort, "sorting does not change projection");
  for (const sort_order of [-5000001, 5000001, 0.5, "1"]) {
    assert.equal((await request("/http/sort-order", { sort_order })).status, 400);
  }
  assert.equal((await request("/missing/sort-order", { sort_order: 0 })).status, 404);
  assert.equal((await request("/http/members/add", { ids: [second, "bad"] })).status, 200);
  assert.equal((await request("/http/members/add", { ids: Array(201).fill(second) })).status, 400);
  assert.equal((await request("/http/members/remove", { ids: [second] })).status, 200);
  assert.equal((await request("/http/delete", {})).status, 403, "direct requests must enforce super-only delete");
  assert.equal((await request("/http/delete", {}, "super")).status, 200);
  assert.equal((await request("/http/members/add", { ids: [second] })).status, 404);
  for (const [index, sort_order] of [undefined, 0, -9, 5000000].entries()) {
    const slug = `created-order-${index}`;
    assert.equal((await request("", { slug, sort_order })).status, 200);
    assert.equal((await listImageGroups()).find((item) => item.slug === slug)!.sort_order, sort_order ?? 0);
    assert.equal((await request(`/${slug}/delete`, {}, "super")).status, 200);
  }
  for (const sort_order of [-5000001, 5000001, 0.5, "1", null]) {
    assert.equal((await request("", { slug: "invalid-order", sort_order })).status, 400);
  }
  // Compare the public contract before projection initialization (PG) and after (Redis).
  const { redis } = runtime.redisClient;
  const coordinator = await import("../../../../packages/server/src/images/ready-cache/coordinator.ts");
  const { neverAbortedSignal } = await import("../../../../packages/server/src/core/abort.ts");
  const { interceptPoolConnections } = await import("./database-faults.mts");
  const { createImageFilterPlan } = await import("../../../../packages/server/src/images/filter-plan.ts");
  const { resolveReadyImageFilterIndex } = await import("../../../../packages/server/src/images/ready-cache/indexes/filter.ts");
  const { readReadyImageById } = await import("../../../../packages/server/src/images/ready-cache/query.ts");
  const { readReadyImageCountSnapshot } = await import("../../../../packages/server/src/images/ready-cache/counts/query.ts");
  const { READY_IMAGE_STATS_KEY, READY_IMAGE_DERIVED_REGISTRY_LRU_KEY } = await import("../../../../packages/server/src/images/ready-cache/keys.ts");
  const { registerRandomRoutes } = await import("../../../../packages/server/src/routes/random.ts");
  const publicApp = new Hono();
  publicApp.onError((error, c) => handleApiError(c, error));
  registerRandomRoutes(publicApp);
  const rows = Array.from({ length: 221 }, (_, i) => ({
    id: `00000000-0000-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
    device: i % 2 ? "pc" : "mb", brightness: i % 3 ? "light" : "dark"
  }));
  await pool.query("INSERT INTO theme(slug) VALUES('group-theme')");
  await pool.query("INSERT INTO author(slug) VALUES('group-author')");
  await pool.query("INSERT INTO tag(slug) VALUES('group-tag')");
  for (const [i, row] of rows.entries()) {
    await pool.query(
      `INSERT INTO metadata(id,created_by,storage_slug,device,brightness,image_time,theme,author,
        l_width,l_height,l_byte_size,l_md5,m_width,m_height,m_byte_size,m_md5,s_width,s_height,s_byte_size,s_md5)
       VALUES($1,'integration-admin','local',$2,$3,$4,'group-theme','group-author',1,1,1,$5,1,1,1,$5,1,1,1,$5)`,
      [row.id, row.device, row.brightness, new Date(1700000000000 + i), "a".repeat(32)]
    );
    await pool.query("INSERT INTO image_tag VALUES($1,'group-tag')", [row.id]);
  }
  for (const slug of ["large", "pair", "empty", "mobile"]) await groups.createImageGroup(slug, slug);
  await groups.addImageGroupMembers("large", rows.slice(0, 200).map((row) => row.id));
  await groups.addImageGroupMembers("large", rows.slice(200, 220).map((row) => row.id));
  await groups.addImageGroupMembers("pair", [rows[0]!.id, rows[220]!.id]);
  await groups.addImageGroupMembers("mobile", [rows[0]!.id]);
  const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const randomRequest = (query: string, method = "GET", userAgent = "unknown-test-agent") => publicApp.request(
    `http://images.example/random?${query}`,
    { method, headers: { Referer: "http://images.example/gallery", "user-agent": userAgent } }
  );
  const read = async (query: string, userAgent?: string) => {
    const response = await randomRequest(`mode=json&${query}`, "GET", userAgent);
    assert.equal(response.status, 200, query + " " + await response.clone().text());
    const body = await response.json() as { fallback: string[]; items: { id: string; groups?: string[] }[] };
    assert.ok(body.items.every((item) => !("groups" in item)), "public JSON never exposes internal memberships");
    return body;
  };
  const sorted = (items: { id: string }[]) => items.map((item) => item.id).sort();
  const queries = [
    "group=large&device=all&limit=17", "group=pair&limit=200", "group=large,pair&limit=146",
    `group=mobile&id=${rows[1]!.id}&limit=200`, `id=${rows[0]!.id},${rows[1]!.id},0000000000dd&limit=200`,
    "group=large&device=pc&brightness=dark&theme=group-theme&tag=group-tag&author=group-author&limit=200",
    "group=pair&theme=missing&fallback=theme&limit=200"
  ].map((query) => query + "&seed=group-window");
  const pgResults = [];
  for (const query of queries) pgResults.push((await read(query)).items.map((item) => item.id));
  const verify = async () => {
    const historyKeys = await redis.keys("imageshow:random_recent:*");
    if (historyKeys.length) await redis.unlink(...historyKeys);
    for (const query of ["group=missing", "group=empty", "group=missing&fallback=all", `id=${missing}&fallback=all`]) {
      assert.equal((await randomRequest(`mode=json&${query}`)).status, 404, query);
    }
    for (const scope of ["group=mobile", `id=${rows[0]!.id}`, `group=mobile&id=${rows[0]!.id}`]) {
      assert.equal((await randomRequest(`mode=json&${scope}`, "GET", desktop)).status, 404, scope);
      assert.deepEqual(sorted((await read(`${scope}&device=all`, desktop)).items), [rows[0]!.id]);
      const relaxed = await read(`${scope}&fallback=device`, desktop);
      assert.deepEqual(relaxed.fallback, ["device"]);
      assert.deepEqual(sorted(relaxed.items), [rows[0]!.id]);
      const combined = await read(`${scope}&theme=missing&fallback=device,theme`, desktop);
      assert.deepEqual(new Set(combined.fallback), new Set(["device", "theme"]));
      assert.deepEqual(sorted(combined.items), [rows[0]!.id]);
    }
    const page = await read("group=large&device=all&limit=200");
    const next = await read("group=large&device=all&limit=200");
    assert.equal(new Set([...sorted(page.items), ...sorted(next.items)]).size, 220, "recent history covers groups above 200 over repeated requests");
    const firstPick = await read("group=pair");
    const nextPick = await read("group=pair");
    assert.notEqual(firstPick.items[0]!.id, nextPick.items[0]!.id);
    assert.equal((await randomRequest("mode=redirect&device=mb&seed=mobile&group=mobile")).status, 302);
    const headQuery = "mode=json&group=pair&seed=head&limit=200";
    const get = await randomRequest(headQuery);
    const head = await randomRequest(headQuery, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), get.headers.get("content-length"));
    assert.equal(await head.text(), "");
  };
  await verify();
  try {
    assert.equal((await coordinator.initializeReadyImageCacheCoordinator()).readable, true);
    // Warm only persistent group/attribute results; ID ranges are always request-owned.
    for (const plan of [
      ...["large", "pair", "mobile", "empty"].map((slug) => createImageFilterPlan({ range: { groups: [slug], ids: [] } })),
      createImageFilterPlan({ range: { groups: ["large", "pair"], ids: [] } }),
      createImageFilterPlan({ devices: ["mb"] }),
      createImageFilterPlan({ devices: ["pc"], brightnesses: ["dark"], theme: { include: ["group-theme"] }, tag: { anyOf: [["group-tag"]] }, author: { include: ["group-author"] }, range: { groups: ["large"], ids: [] } })
    ]) {
      const index = await pollUntil(() => resolveReadyImageFilterIndex(plan, neverAbortedSignal), (result) => result !== null);
      assert.notEqual(index, null, "persistent indexes must finish building before registry assertions");
    }
    for (const query of queries) await read(query);
    let connections = 0;
    const restore = interceptPoolConnections(pool, () => { connections += 1; });
    try {
      for (const [i, query] of queries.entries()) {
        assert.deepEqual((await read(query)).items.map((item) => item.id), pgResults[i], query);
      }
    } finally { restore(); }
    assert.equal(connections, 0, "warm scope selection must actually use Redis");
    await verify();
    const registry = (await redis.zrange(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY, "0", "-1")).sort();
    for (let i = 0; i < 4; i += 1) await read(`group=mobile,unknown-${i}&id=${rows[i + 1]!.id}&device=all`);
    assert.deepEqual((await redis.zrange(READY_IMAGE_DERIVED_REGISTRY_LRU_KEY, "0", "-1")).sort(), registry);
    assert.deepEqual(await redis.keys("imageshow:cache:variants:derived:temp:filter:*"), [], "request-owned range sets and metadata are unlinked");
    assert.equal(await redis.hget(READY_IMAGE_STATS_KEY, "group:large"), "220");
    const counts = await readReadyImageCountSnapshot(createImageFilterPlan({}), neverAbortedSignal);
    assert.equal(counts.cached, true);
    if (counts.cached) assert.equal(JSON.stringify(counts.value).includes("group:"), false);
    await groups.removeImageGroupMembers("pair", [rows[0]!.id]);
    assert.deepEqual(sorted((await read("group=pair&limit=200")).items), [rows[220]!.id]);
    // The preceding request may publish a rebuilt group index under the write fence.
    const item = await pollUntil(() => readReadyImageById(rows[0]!.id), (result) => result.cached);
    assert.equal(item.cached, true);
    if (item.cached) assert.deepEqual(item.value!.groups, ["large", "mobile"]);
    await trash.moveImagesToTrash([rows[0]!.id]);
    assert.equal((await randomRequest("mode=json&group=mobile&fallback=all")).status, 404);
    await trash.restoreImages([rows[0]!.id]);
    assert.deepEqual(sorted((await read("group=mobile")).items), [rows[0]!.id]);
    await groups.deleteImageGroup("mobile");
    assert.equal((await randomRequest("mode=json&group=mobile")).status, 404, "deletion invalidates slug cache");
    await groups.createImageGroup("mobile", "recreated");
    await groups.addImageGroupMembers("mobile", [rows[1]!.id]);
    assert.deepEqual(sorted((await read("group=mobile")).items), [rows[1]!.id]);
    const { driver } = await runtime.storageRegistry.resolveStorageAccess("local");
    const { imageObjectKey } = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
    await driver.writeBuffer("medium", imageObjectKey(rows[1]!.id), Buffer.from("x"), "image/webp");
    const proxy = await randomRequest("mode=proxy&group=mobile");
    assert.equal(proxy.status, 200);
    assert.equal(await proxy.text(), "x");
    assert.equal((await randomRequest("mode=proxy&group=mobile", "HEAD")).status, 200);
  } finally {
    await coordinator.stopReadyImageCacheCoordinator();
  }
});
