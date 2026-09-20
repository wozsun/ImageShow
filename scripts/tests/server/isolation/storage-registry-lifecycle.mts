import { storageObjectKey } from "@imageshow/shared/browser";
import { sortOrderMin, sortOrderMax } from "@imageshow/shared/browser";
import assert from "node:assert/strict";
import type { StorageDriver } from "../../../../packages/server/src/storage/drivers/driver.ts";
import { interceptSqlQueries } from "./database-faults.mts";
import { removeDriverObject } from "./storage-fixture.mts";
import { randomUUID } from "node:crypto";

import { runIntegrationScenario } from "./integration-runtime.mts";
import { createS3HttpFixture } from "../../support/s3-http-fixture.ts";
import { Hono } from "hono";
import type { AdminSession } from "../../../../packages/server/src/users/admin-session.ts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const registry = await import("../../../../packages/server/src/storage/backends/registry.ts");
const backendUpdate = await import("../../../../packages/server/src/storage/backends/update.ts");
const publicUrls = await import("../../../../packages/server/src/storage/objects/public-urls.ts");

const storageCheck = await import("../../../../packages/server/src/checks/storage-check.ts");
const objectAccess = await import("../../../../packages/server/src/storage/objects/access.ts");
{
  const { createHttpApp } = await import("../../../../packages/server/src/http-app.ts");
  const { createConfigPackage } = await import("../../../../packages/server/src/config/config-package.ts");
  const originalDomain = runtime.runtimeConfigStore.getRuntimeConfig().site.domain;
  await runtime.runtimeConfigStore.updateRuntimeConfig({ site: { domain: "main.example.test" } });
  const local = (await registry.resolveStorageAccess("local")).driver;
  const key = storageObjectKey("00000000-0000-7000-8000-0000000000a5", "webp");
  const bytes = Buffer.from("synthetic-local-public-image");
  await local.writeBuffer("full", key, bytes, "image/webp");
  await local.writeBuffer("thumbs", key, bytes, "image/webp");
  const app = createHttpApp({ businessGateIsOpen: () => true, requireRedis: async () => undefined });
  const request = (host: string, path = `/pictures/full/${key}`, method = "GET", headers: Record<string, string> = {}) => (
    app.request(`http://internal.example.test${path}`, { method, headers: { Host: host, ...headers } })
  );
  try {
    await backendUpdate.updateStorageBackend("local", { public_base_url: "https://IMAGES.example.test/pictures/" });
    assert.equal(registry.publishedLocalPublicUrl(), "https://images.example.test/pictures");
    assert.equal((await registry.resolveStorageAccess("local")).driver, local);
    assert.equal(publicUrls.directStorageObjectUrl(await registry.getStorageBackend("local"), "full", key),
      `https://images.example.test/pictures/full/${key}`);
    const pkg = await createConfigPackage();
    assert.ok(pkg.storage_backends.every((backend) => backend.slug !== "local"));
    await assert.rejects(backendUpdate.updateStorageBackend("local", { public_base_url: "https://main.example.test/pictures" }),
      { code: "storage_public_url_host_conflict" });
    assert.equal(registry.publishedLocalPublicUrl(), "https://images.example.test/pictures");

    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { registerSettingsRoutes } = await import("../../../../packages/server/src/routes/settings.ts");
    const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
    const settingsApp = new Hono<{ Variables: { session: AdminSession } }>();
    settingsApp.onError((error, context) => handleApiError(context, error));
    settingsApp.use("*", async (context, next) => {
      context.set("session", { id: "settings-test", username: "integration-admin", role: "super", csrf: "settings-csrf" });
      await next();
    });
    registerSettingsRoutes(settingsApp as unknown as Hono);
    const { registerAdvancedConfigRoutes } = await import("../../../../packages/server/src/routes/advanced-config.ts");
    registerAdvancedConfigRoutes(settingsApp as unknown as Hono);
    const configFile = join(runtime.dataDirectory, "config.json");
    const previousFile = await readFile(configFile, "utf8");
    try {
      const conflict = JSON.parse(previousFile);
      conflict.site.domain = "images.example.test";
      await writeFile(configFile, JSON.stringify(conflict));
      const reload = await settingsApp.request("http://main.example.test/api/admin/settings/reload", { method: "POST" });
      assert.equal(reload.status, 400);
      assert.equal((await reload.json()).code, "storage_public_url_host_conflict");
      assert.equal(runtime.runtimeConfigStore.getRuntimeConfig().site.domain, "main.example.test");
      assert.equal(registry.publishedLocalPublicUrl(), "https://images.example.test/pictures");
    } finally { await writeFile(configFile, previousFile); }

    const fullConfigRequest = (config: unknown, validate = false) => settingsApp.request(
      `http://main.example.test/api/admin/advanced-config/runtime${validate ? "/validate" : ""}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config })
      });
    const savedConfig = structuredClone(runtime.runtimeConfigStore.getRuntimeConfig());
    const conflictConfig = { ...savedConfig, site: { ...savedConfig.site, domain: "images.example.test" } };
    for (const validate of [true, false]) {
      const result = await fullConfigRequest(conflictConfig, validate);
      assert.equal(result.status, 400);
      assert.equal((await result.json()).code, "storage_public_url_host_conflict");
      assert.deepEqual(runtime.runtimeConfigStore.getRuntimeConfig(), savedConfig);
      assert.equal(await readFile(configFile, "utf8"), previousFile);
    }
    const renamedConfig = { ...savedConfig, site: { ...savedConfig.site, domain: "new-main.example.test" } };
    assert.equal((await fullConfigRequest(renamedConfig, true)).status, 200);
    assert.equal((await fullConfigRequest(renamedConfig)).status, 200);
    assert.equal(runtime.runtimeConfigStore.getRuntimeConfig().site.domain, "new-main.example.test");
    assert.equal((await fullConfigRequest(savedConfig)).status, 200);

    // No metadata record exists: this origin reads only the object, including during a move's cleanup window.
    const response = await request("images.example.test");
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const etag = response.headers.get("ETag")!;
    assert.ok(etag);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(response.headers.get("Cache-Control")!, /immutable/);
    for (const [method, headers, expected] of [
      ["HEAD", {}, 200], ["GET", { "If-None-Match": etag }, 304],
      ["GET", { Range: "bytes=0-2" }, 206],
      ["GET", { Range: "bytes=0-2", "If-None-Match": etag }, 304],
      ["GET", { Range: "bytes=0-2", "If-Range": '"different"' }, 200],
      ["GET", { Range: "bytes=99999-" }, 416]
    ] as const) {
      const result = await request("IMAGES.EXAMPLE.TEST:443", undefined, method, headers as Record<string, string>);
      assert.equal(result.status, expected);
      const body = Buffer.from(await result.arrayBuffer());
      if (expected === 304 || method === "HEAD") assert.equal(body.length, 0);
      if (expected === 206) assert.deepEqual(body, bytes.subarray(0, 3));
      if (expected !== 416) assert.equal(result.headers.get("Access-Control-Allow-Origin"), "*");
    }
    const preflight = await request("images.example.test", undefined, "OPTIONS", {
      Origin: "https://main.example.test", "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Range, If-None-Match"
    });
    assert.equal(preflight.status, 204);
    for (const path of ["/", "/api/site-config", "/api/admin/storage/backends", "/random", "/livez",
      `/images/full/${key}`, `/pictures/full/not-a-key`, `/pictures/original/${key}`, `/pictures/full/${key}.candidate-x`]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal((await request("images.example.test", path, method)).status, 404);
    }
    assert.equal((await request("images.example.test", undefined, "POST")).status, 404);
    const thumb = await request("images.example.test", `/pictures/thumbs/${key}`);
    assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), bytes);
    await database.pool.query("INSERT INTO metadata (id, storage_slug, device, brightness, ext, md5, created_by) VALUES ($1, 'local', 'pc', 'light', 'webp', $2, 'integration-admin')",
      ["00000000-0000-7000-8000-0000000000a5", "0".repeat(32)]);
    const main = await request("main.example.test", `/images/full/${key}`);
    assert.equal(main.status, 302);
    assert.equal(main.headers.get("Location"), `https://images.example.test/pictures/full/${key}`);
    await database.pool.query("DELETE FROM metadata WHERE id=$1", ["00000000-0000-7000-8000-0000000000a5"]);
    const originalHget = runtime.redisClient.redis.hget;
    const restoreSql = interceptSqlQueries(database.pool, async () => { throw new Error("hot local read must not query SQL"); });
    runtime.redisClient.redis.hget = (() => { throw new Error("local origin must not query image projection"); }) as typeof originalHget;
    try {
      const hot = await request("images.example.test", undefined, "GET", { "If-None-Match": etag });
      assert.equal(hot.status, 304);
    } finally { restoreSql(); runtime.redisClient.redis.hget = originalHget; }
    await backendUpdate.updateStorageBackend("local", { public_base_url: "https://new-images.example.test" });
    assert.equal((await request("images.example.test")).status, 404);
    const newResponse = await request("new-images.example.test", `/full/${key}`);
    assert.equal(newResponse.headers.get("ETag"), etag);
    await newResponse.body?.cancel();
    await backendUpdate.updateStorageBackend("local", { public_base_url: "https://new-images.example.test/图片" });
    const encodedUrl = publicUrls.directStorageObjectUrl(await registry.getStorageBackend("local"), "thumbs", key);
    const encodedResponse = await request("new-images.example.test", new URL(encodedUrl).pathname);
    assert.equal(encodedResponse.status, 200);
    assert.deepEqual(Buffer.from(await encodedResponse.arrayBuffer()), bytes);
    await backendUpdate.updateStorageBackend("local", { public_base_url: "https://new-images.example.test" });
    await removeDriverObject(local, "full", key);
    const missing = await request("new-images.example.test", `/full/${key}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("Cache-Control"), "no-store");
    registry.invalidateStorageBackendRegistry();
    assert.equal((await registry.getStorageBackend("local")).type, "local");
    assert.equal(registry.publishedLocalPublicUrl(), "https://new-images.example.test");
    await backendUpdate.updateStorageBackend("local", { public_base_url: "" });
    assert.equal((await request("new-images.example.test", `/thumbs/${key}`)).status, 404);
  } finally {
    await backendUpdate.updateStorageBackend("local", { public_base_url: "" });
    await removeDriverObject(local, "full", key);
    await removeDriverObject(local, "thumbs", key);
    await runtime.runtimeConfigStore.updateRuntimeConfig({ site: { domain: originalDomain } });
  }
}
  const registryBackend = "registry-contract";
  const registryConfig = {
    endpoint: "https://objects.example.com",
    region: "ap-southeast-1",
    bucket: "gallery",
    access_key_id: "key",
    secret_access_key: "secret",
    force_path_style: false,
    root_path: "/images",
    public_base_url: "https://cdn.example.com",
    connect_timeout_seconds: 15,
    idle_timeout_seconds: 15,
    task_timeout_seconds: 300
  };
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, config) "
      + "VALUES ($1, 'Registry contract', 's3', $2::jsonb)",
    [registryBackend, JSON.stringify(registryConfig)]
  );
  registry.invalidateStorageBackendRegistry();
  const registryExampleKey = storageObjectKey(
    "00000000-0000-7000-8000-0000000000aa",
    "webp"
  );
  const projectedRegistryUrls = await publicUrls.publicImageUrl(
    { id: "00000000-0000-7000-8000-0000000000aa", ext: "webp" },
    registryBackend
  );
  assert.equal(
    projectedRegistryUrls,
    "https://cdn.example.com/images/full/" + registryExampleKey
  );
  const { publicShowImageCards } = await import("../../../../packages/server/src/images/presenter.ts");
  const card = { id: "00000000-0000-7000-8000-0000000000aa", title: "Card", width: 800, height: 600,
    storage_slug: registryBackend };
  const cards = await publicShowImageCards([card, { ...card, storage_slug: "local" }]);
  assert.equal(cards[0]!.thumb_url, "https://cdn.example.com/images/thumbs/" + registryExampleKey);
  assert.equal(cards[1]!.thumb_url, "/images/thumbs/" + registryExampleKey);
  const firstRegistryAccess = await registry.resolveStorageAccess(
    registryBackend
  );
  assert.equal(publicUrls.directStorageObjectUrl(
    firstRegistryAccess.config,
    "full",
    registryExampleKey
  ), "https://cdn.example.com/images/full/" + registryExampleKey);

  await backendUpdate.updateStorageBackend(registryBackend, {
    s3: { public_base_url: "https://assets.example.com" }
  });
  const presentationRegistryAccess = await registry.resolveStorageAccess(
    registryBackend
  );
  assert.equal(presentationRegistryAccess.driver, firstRegistryAccess.driver);
  assert.equal(publicUrls.directStorageObjectUrl(
    presentationRegistryAccess.config,
    "full",
    registryExampleKey
  ), "https://assets.example.com/images/full/" + registryExampleKey);

  await database.pool.query(
    "UPDATE storage_backend SET config = config || $2::jsonb WHERE slug=$1",
    [registryBackend, JSON.stringify({ region: "ap-southeast-2" })]
  );
  registry.invalidateStorageBackendRegistry();
  const replacementRegistryAccess = await registry.resolveStorageAccess(
    registryBackend
  );
  assert.notEqual(replacementRegistryAccess.driver, firstRegistryAccess.driver);
  await assert.rejects(
    () => firstRegistryAccess.driver.exists("full", "retired.webp"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "storage_driver_retired"
  );

  const registryOriginalPoolQuery = database.pool.query.bind(database.pool);
  let releaseRegistryLoad!: () => void;
  let registryLoadStarted!: () => void;
  const registryLoadGate = new Promise<void>((resolve) => {
    releaseRegistryLoad = resolve;
  });
  const registryLoadStartedPromise = new Promise<void>((resolve) => {
    registryLoadStarted = resolve;
  });
  let delayRegistryLoad = true;
  const restoreRegistryQuery = interceptSqlQueries(database.pool, (text, _values, runQuery) => {
    const query = runQuery();
    if (
      delayRegistryLoad
      && typeof text === "string"
      && text.includes("FROM storage_backend")
    ) {
      delayRegistryLoad = false;
      return query.then(async (result) => {
        registryLoadStarted();
        await registryLoadGate;
        return result;
      });
    }
    return query;
  });
  try {
    registry.invalidateStorageBackendRegistry();
    const pendingRegistryAccess = registry.resolveStorageAccess(
      registryBackend
    );
    await registryLoadStartedPromise;
    await registryOriginalPoolQuery(
      "UPDATE storage_backend SET config = config || $2::jsonb WHERE slug=$1",
      [registryBackend, JSON.stringify({ region: "ap-southeast-3" })]
    );
    registry.invalidateStorageBackendRegistry();
    releaseRegistryLoad();
    const currentRegistryAccess = await pendingRegistryAccess;
    assert.equal(currentRegistryAccess.config.type, "s3");
    assert.ok("s3" in currentRegistryAccess.config);
    assert.equal(currentRegistryAccess.config.s3.region, "ap-southeast-3");
    assert.notEqual(
      currentRegistryAccess.driver,
      replacementRegistryAccess.driver
    );
  } finally {
    releaseRegistryLoad();
    restoreRegistryQuery();
  }

  const inaccessibleAlias = "registry-inaccessible-alias";
  const inaccessibleAliasImage = randomUUID();
  const inaccessibleAliasKey = storageObjectKey(inaccessibleAliasImage, "webp");
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, config) "
      + "VALUES ($1, 'Registry inaccessible alias', 's3', $2::jsonb)",
    [
      inaccessibleAlias,
      JSON.stringify({
        ...registryConfig,
        access_key_id: "inaccessible-key",
        secret_access_key: "inaccessible-secret"
      })
    ]
  );
  await database.pool.query(
    `INSERT INTO metadata (id, created_by, storage_slug, device, brightness, theme, ext, md5, thumbnail_size)
       VALUES ($1, 'integration-admin', $2, 'pc', 'dark', NULL, 'webp', $3, 1)`,
    [
        inaccessibleAliasImage,
        inaccessibleAlias,
        "0".repeat(32)
      ]
  );
  registry.invalidateStorageBackendRegistry();
  const listingAliasAccess = await registry.resolveStorageAccess(registryBackend);
  const inaccessibleAliasAccess = await registry.resolveStorageAccess(inaccessibleAlias);
  assert.notEqual(listingAliasAccess.driver, inaccessibleAliasAccess.driver);
  const originalListingAliasListKeys = listingAliasAccess.driver.listKeys.bind(
    listingAliasAccess.driver
  );
  const originalInaccessibleAliasListKeys = inaccessibleAliasAccess.driver.listKeys.bind(
    inaccessibleAliasAccess.driver
  );
  const originalInaccessibleAliasExists = inaccessibleAliasAccess.driver.exists.bind(
    inaccessibleAliasAccess.driver
  );
  const visibleStorageListing: StorageDriver["listKeys"] = (prefix) => (async function* () {
    const keys = prefix === "full" ? [inaccessibleAliasKey] : [];
    if (keys.length) yield keys;
    return { complete: true as const, count: keys.length };
  })();
  listingAliasAccess.driver.listKeys = visibleStorageListing;
  inaccessibleAliasAccess.driver.listKeys = visibleStorageListing;
  inaccessibleAliasAccess.driver.exists = async () => false;
  try {
    const aliasCheck = await storageCheck.checkStorage();
    assert.ok(aliasCheck.unavailable_backends.some((entry) => (
      entry.backend === inaccessibleAlias
      && entry.blocks_maintenance === false
      && String(entry.error).includes("此逻辑后端不可读")
    )), JSON.stringify(aliasCheck));
  } finally {
    listingAliasAccess.driver.listKeys = originalListingAliasListKeys;
    inaccessibleAliasAccess.driver.listKeys = originalInaccessibleAliasListKeys;
    inaccessibleAliasAccess.driver.exists = originalInaccessibleAliasExists;
    await database.pool.query("DELETE FROM metadata WHERE id=$1", [inaccessibleAliasImage]);
    await database.pool.query("DELETE FROM storage_backend WHERE slug=$1", [inaccessibleAlias]);
    registry.invalidateStorageBackendRegistry();
    await registry.listStorageBackends();
  }

  const delayedReadBackend = "delayed-read-contract";
  const delayedReadKey = "registry/delayed-read.webp";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type) "
      + "VALUES ($1, 'Delayed read contract', 'local')",
    [delayedReadBackend]
  );
  registry.invalidateStorageBackendRegistry();
  const delayedReadAccess = await registry.resolveStorageAccess(
    delayedReadBackend
  );
  await delayedReadAccess.driver.writeBuffer(
    "full",
    delayedReadKey,
    Buffer.from("must-not-open-through-deleted-alias"),
    "image/webp"
  );
  const delayedReadable = await objectAccess.resolveReadableObject(
    "full",
    delayedReadKey,
    delayedReadBackend
  );
  await database.pool.query(
    "DELETE FROM storage_backend WHERE slug=$1",
    [delayedReadBackend]
  );
  registry.invalidateStorageBackendRegistry();
  await assert.rejects(
    () => delayedReadable.open(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "storage_backend_not_found"
  );
  const currentLocalAccess = await registry.resolveStorageAccess("local");
  await removeDriverObject(currentLocalAccess.driver, "full", delayedReadKey);
  await database.pool.query("DELETE FROM storage_backend WHERE slug=$1", [registryBackend]);
  registry.invalidateStorageBackendRegistry();

  const s3 = await createS3HttpFixture();
  const mutations = await import("../../../../packages/server/src/storage/backends/mutations.ts");
  const probe = await import("../../../../packages/server/src/storage/backends/probe.ts");
  const selfTest = await import("../../../../packages/server/src/storage/backends/self-test.ts");
  const readModel = await import("../../../../packages/server/src/storage/backends/read-model.ts");
  const readConfig = async (slug = "capability") => (await database.pool.query(
    "SELECT config FROM storage_backend WHERE slug=$1", [slug]
  )).rows[0]?.config;
  const capDto = async () => (await readModel.getStorageBackendsForAdmin())
    .find((backend) => backend.slug === "capability");
  try {
    await mutations.createStorageBackend({ slug: "capability", display_name: "Capability", s3: s3.settings });
    assert.deepEqual((await readConfig()).capabilities, { content_md5: true });
    const first = await registry.resolveStorageAccess("capability");
    const { secret_access_key: _secret, ...publicSettings } = s3.settings;
    assert.deepEqual(await capDto(), {
      slug: "capability", sort_order: -1, display_name: "Capability", type: "s3", enabled: true, is_default: false,
      image_count: 0, ingestion_session_count: 0, cleanup_job_count: 0,
      failed_cleanup_job_count: 0, exhausted_cleanup_job_count: 0,
      deletion: { action: "delete", blockers: [] }, content_md5: true,
      s3: { ...publicSettings, secret_access_key_configured: true }
    });
    s3.requests.length = 0;
    await backendUpdate.updateStorageBackend("capability", { display_name: "Renamed" });
    await backendUpdate.updateStorageBackend("capability", { s3: { public_base_url: "https://cdn.example.test" } });
    assert.equal(s3.requests.length, 0);
    assert.equal((await registry.resolveStorageAccess("capability")).driver, first.driver);
    assert.deepEqual((await readConfig()).capabilities, { content_md5: true });

    await database.pool.query("UPDATE storage_backend SET config=config-'capabilities' WHERE slug='capability'");
    registry.invalidateStorageBackendRegistry();
    const unknownDto = await capDto();
    assert.equal(unknownDto?.type === "s3" ? unknownDto.content_md5 : "wrong type", null);
    s3.state.capability = "ignored";
    await backendUpdate.updateStorageBackend("capability", { s3: { access_key_id: s3.settings.access_key_id } });
    assert.deepEqual((await readConfig()).capabilities, { content_md5: false });
    const unsupportedDto = await capDto();
    assert.equal(unsupportedDto?.type === "s3" && unsupportedDto.content_md5, false);
    assert.equal((await registry.resolveStorageAccess("capability")).driver, first.driver,
      "能力刷新不应退休连接设置相同的 driver");

    s3.state.capability = "enforced";
    await selfTest.testStorageBackend(await probe.resolveStorageTestConfig({ slug: "capability" }));
    assert.deepEqual((await readConfig()).capabilities, { content_md5: true });
    s3.state.capability = "unsupported";
    await selfTest.testStorageBackend(await probe.resolveStorageTestConfig({
      slug: "capability", s3: { access_key_id: randomUUID() }
    }));
    assert.deepEqual((await readConfig()).capabilities, { content_md5: true },
      "未保存连接的探测结果仅属于草稿");
    await backendUpdate.updateStorageBackend("capability", { s3: { access_key_id: randomUUID() } });
    assert.deepEqual((await readConfig()).capabilities, { content_md5: false });
    assert.notEqual((await registry.resolveStorageAccess("capability")).driver, first.driver);

    const snapshot = await readConfig();
    s3.state.putError = () => ({ status: 403, code: "AccessDenied", message: "controlled access failure" });
    await assert.rejects(backendUpdate.updateStorageBackend("capability", { s3: { secret_access_key: randomUUID() } }),
      { name: "AccessDenied" });
    await assert.rejects(mutations.createStorageBackend({ slug: "rejected", display_name: "Rejected", s3: s3.settings }),
      { name: "AccessDenied" });
    assert.deepEqual(await readConfig(), snapshot);
    assert.equal(await readConfig("rejected"), undefined);
    s3.state.putError = undefined;

    s3.state.capability = "enforced";
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    s3.state.beforeRequest = async (request) => {
      if (!held && request.method === "HEAD" && request.key.endsWith("-valid")) {
        held = true; reached.resolve(); await release.promise;
      }
    };
    const checking = selfTest.testStorageBackend(await probe.resolveStorageTestConfig({ slug: "capability" }));
    const outcome = assert.rejects(checking, { code: "storage_backend_changed" });
    try {
      await reached.promise;
      s3.state.capability = "ignored";
      await backendUpdate.updateStorageBackend("capability", { s3: { region: "new-region" } });
      release.resolve();
      await outcome;
      assert.deepEqual((await readConfig()).capabilities, { content_md5: false });
      assert.equal((await readConfig()).region, "new-region");
    } finally { release.resolve(); await Promise.allSettled([checking, outcome]); s3.state.beforeRequest = undefined; }

    const { registerStorageRoutes } = await import("../../../../packages/server/src/routes/storage.ts");
    const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
    const app = new Hono<{ Variables: { session: AdminSession } }>();
    app.onError((error, context) => handleApiError(context, error));
    app.use("/api/admin/*", async (context, next) => {
      context.set("session", { id: "storage-route", username: "integration-admin",
        role: context.req.header("x-role") === "super" ? "super" : "image", csrf: "test" });
      await next();
    });
    registerStorageRoutes(app as unknown as Hono);
    const post = (path: string, body: unknown, role: "super" | "image") => app.request(`/api/admin/storage/${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-role": role }, body: JSON.stringify(body)
    });
    assert.equal((await post("test", { slug: "capability" }, "image")).status, 403);
    assert.equal((await post("backends/local", { public_base_url: "https://images.example.test" }, "image")).status, 403);
    assert.equal((await post("backends/local", { public_base_url: "http://images.example.test" }, "super")).status, 400);
    assert.equal((await post("backends/local", { public_base_url: "https://images.example.test" }, "super")).status, 200);
    assert.equal((await post("backends/local", { public_base_url: "" }, "super")).status, 200);
    await mutations.createStorageBackend({ slug: "capability-peer", display_name: "Peer", s3: s3.settings });
    try {
    const { getStorageBackendsForAdmin, listStorageBackendOptions } = await import("../../../../packages/server/src/storage/backends/read-model.ts");
    const beforeSorting = (await database.pool.query("SELECT * FROM storage_backend WHERE slug <> 'capability' ORDER BY slug")).rows;
    const sortPath = "backends/capability/sort-order";
    assert.equal((await post(sortPath, { sort_order: 5 }, "image")).status, 403);
    assert.equal((await post("backends/local/sort-order", { sort_order: 5 }, "super")).status, 400);
    assert.equal((await post("backends/missing-sort/sort-order", { sort_order: 5 }, "super")).status, 404);
    for (const sort_order of [null, "4", 1.5, sortOrderMax + 1, sortOrderMin - 1]) {
      assert.equal((await post(sortPath, { sort_order }, "super")).status, 400);
    }
    for (const [sort_order, expected] of [
      [sortOrderMin, ["local", "capability-peer", "capability"]],
      [sortOrderMax, ["local", "capability", "capability-peer"]],
      [-2, ["local", "capability", "capability-peer"]]
    ] as const) {
      assert.equal((await post(sortPath, { sort_order }, "super")).status, 200);
      const items = await getStorageBackendsForAdmin();
      assert.deepEqual(items.map((item) => item.slug), expected);
      assert.equal(items.find((item) => item.slug === "capability")!.sort_order, sort_order);
      assert.deepEqual((await listStorageBackendOptions()).map((item) => item.slug), items.map((item) => item.slug));
    }
    assert.deepEqual((await database.pool.query("SELECT * FROM storage_backend WHERE slug <> 'capability' ORDER BY slug")).rows, beforeSorting);
    } finally {
      await mutations.deleteStorageBackend("capability-peer");
    }
    assert.equal((await post("backends/capability", { s3: { capabilities: { content_md5: true } } }, "super")).status, 400);
    assert.equal((await post("test", { slug: "capability" }, "super")).status, 200);
    assert.deepEqual((await readConfig()).capabilities, { content_md5: false });
    assert.equal(s3.objects.size, 0);
    for (const baseline of [-2_147_483_648, sortOrderMin, sortOrderMax, sortOrderMax + 1_000_000, 2_147_483_647]) {
      await database.pool.query("UPDATE storage_backend SET sort_order=$1", [baseline]);
      const before = (await database.pool.query("SELECT slug, sort_order FROM storage_backend ORDER BY slug")).rows;
      const slug = "sort-created";
      await mutations.createStorageBackend({ slug, display_name: "Created", s3: s3.settings });
      assert.equal((await database.pool.query("SELECT sort_order FROM storage_backend WHERE slug=$1", [slug])).rows[0].sort_order,
        Math.max(sortOrderMin, Math.min(sortOrderMax, baseline - 1)));
      assert.deepEqual((await database.pool.query("SELECT slug, sort_order FROM storage_backend WHERE slug<>$1 ORDER BY slug", [slug])).rows, before);
      await mutations.deleteStorageBackend(slug);
      const imported = ["sort-import-a", "sort-import-b"];
      await mutations.importStorageBackends(imported.map(slug => ({ slug, display_name: slug, config: s3.settings, enabled: true, is_default: false })),
        () => undefined, () => undefined);
      assert.deepEqual((await database.pool.query("SELECT sort_order FROM storage_backend WHERE slug=ANY($1::text[]) ORDER BY slug", [imported])).rows.map(row => row.sort_order),
        [1, 2].map(step => Math.max(sortOrderMin, Math.min(sortOrderMax, baseline - step))));
      assert.deepEqual((await database.pool.query("SELECT slug, sort_order FROM storage_backend WHERE NOT slug=ANY($1::text[]) ORDER BY slug", [imported])).rows, before);
      for (const slug of imported) await mutations.deleteStorageBackend(slug);
    }
  } finally {
    await mutations.deleteStorageBackend("capability");
    await s3.close();
  }
});
