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
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const storageCheck = await import("../../../../packages/server/src/checks/storage-check.ts");
const objectAccess = await import("../../../../packages/server/src/storage/objects/access.ts");
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
  const registryExampleKey = imagePaths.storageObjectKey(
    "00000000-0000-7000-8000-0000000000aa",
    "webp"
  );
  const projectedRegistryUrls = await publicUrls.publicImageUrls(
    registryExampleKey,
    registryBackend
  );
  assert.equal(
    projectedRegistryUrls.object_url,
    "https://cdn.example.com/images/full/" + registryExampleKey
  );
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
  const inaccessibleAliasKey = imagePaths.storageObjectKey(inaccessibleAliasImage, "webp");
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
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES "
      + "($1, 'integration-admin', $2, $3, 'pc', 'dark', NULL, 'webp', $4, 1)",
    [inaccessibleAliasImage, inaccessibleAlias, inaccessibleAliasKey, "0".repeat(32)]
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
      slug: "capability", display_name: "Capability", type: "s3", enabled: true, is_default: false,
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
    assert.equal((await post("backends/capability", { s3: { capabilities: { content_md5: true } } }, "super")).status, 400);
    assert.equal((await post("test", { slug: "capability" }, "super")).status, 200);
    assert.deepEqual((await readConfig()).capabilities, { content_md5: false });
    assert.equal(s3.objects.size, 0);
  } finally {
    await mutations.deleteStorageBackend("capability");
    await s3.close();
  }
});
