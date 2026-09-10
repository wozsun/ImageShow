import assert from "node:assert/strict";
import type { StorageDriver } from "../../../../packages/server/src/storage/drivers/driver.ts";
import { interceptSqlQueries } from "./database-faults.mts";
import { removeDriverObject } from "./storage-fixture.mts";
import { randomUUID } from "node:crypto";

import { runIntegrationScenario } from "./integration-runtime.mts";

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

});
