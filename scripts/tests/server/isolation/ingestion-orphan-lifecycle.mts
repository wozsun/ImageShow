import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { installProperties } from "../../support/property-descriptors.ts";
import { activeSession, createIngestionScenarioFixture } from "./ingestion-scenario-fixture.mts";
import { createMaintenanceFixture } from "./storage-maintenance-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const fixture = await createIngestionScenarioFixture(runtime);
  const { access, createImage } = await createMaintenanceFixture(runtime);
  const { appConfig } = await import("@imageshow/shared");
  const { randomUuidV7, randomUuidV7At } = await import("../../../../packages/server/src/core/uuid.ts");
  const identity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
  const { ingestionSessionSemanticHash } = await import("../../../../packages/server/src/images/ingestion/sessions/projection.ts");
  const { semanticIngestionSession } = await import("../../../../packages/server/src/images/ingestion/sessions/transitions.ts");
  const staging = await import("../../../../packages/server/src/images/ingestion/staging-keys.ts");
  const raw = await import("../../../../packages/server/src/images/ingestion/raw/paths.ts");
  const leases = await import("../../../../packages/server/src/images/ingestion/raw/lease-registry.ts");
  const scanner = await import("../../../../packages/server/src/images/ingestion/raw/orphan-scanner.ts");
  const { ingestionOrphanCutoffs } = await import("../../../../packages/server/src/images/ingestion/cleanup/retention.ts");
  const { cleanupIngestionOrphans } = await import("../../../../packages/server/src/images/ingestion/cleanup/orphans.ts");
  const { checkStorage } = await import("../../../../packages/server/src/checks/storage-check.ts");
  const { maintainStorageAndPurgeTasks } = await import("../../../../packages/server/src/checks/storage-maintenance.ts");
  const now = Date.now();
  const cutoffs = ingestionOrphanCutoffs(now);
  const pair = { session_id: identity.createIngestionSessionId("orphan-owner", "import", "active"), image_id: randomUuidV7At(new Date(now)) };
  const oldGeneration = randomUuidV7At(new Date(cutoffs.stagingCutoff - 10_000));
  const makeKey = (generation: string) => staging.ingestionStagingImageKey({ ...pair, generation, execution_token: randomUuidV7() });
  const activeKey = makeKey(oldGeneration);
  const activeCandidate = activeKey + ".candidate-" + randomUUID();
  const activeThumb = staging.ingestionStagingThumbnailKey({ ...pair, generation: oldGeneration, execution_token: randomUuidV7() });
  const oldKey = makeKey(oldGeneration);
  const oldCandidate = oldKey + ".candidate-" + randomUUID();
  const recentKey = makeKey(randomUuidV7());
  const unknownKey = "unclassified-age.webp";
  const template = { ...fixture.importTemplate, ...pair, owner: "orphan-owner", image_time: new Date(now).toISOString() };
  const queued = activeSession((await fixture.ingestionRepository.acceptImportSession({ ...template,
    semantic_hash: ingestionSessionSemanticHash(template) }, fixture.displayOrderKey(pair.session_id, 0, now), now)).session);
  await fixture.ingestionRepository.mutateSemantic(queued, queued.version, semanticIngestionSession(queued, {
    status: "ready", phase: "ready", raw_generation: oldGeneration, raw_size: 6,
    prepared: { ...fixture.preparedTemplate, generation: oldGeneration, prepared_image_key: activeKey, prepared_thumbnail_key: activeThumb }
  }));
  for (const key of [activeKey, activeCandidate, activeThumb, oldKey, oldCandidate, recentKey, unknownKey]) {
    await access.driver.writeBuffer("_uploads", key, Buffer.from("staging"), "image/webp");
  }
  const activeRaw = raw.ingestionRawPath("import", pair, oldGeneration);
  const orphanRaw = raw.ingestionRawPath("import", pair, randomUuidV7());
  const recentRaw = raw.ingestionRawPath("import", pair, randomUuidV7());
  const orphanPart = raw.ingestionRawPartPath("import", pair, randomUuidV7(), randomUuidV7());
  const leasedPart = raw.ingestionRawPartPath("import", pair, randomUuidV7(), randomUuidV7());
  for (const path of [activeRaw, orphanRaw, recentRaw, orphanPart, leasedPart]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "raw-data");
    const modified = path === recentRaw ? now : Math.min(cutoffs.rawCutoff, cutoffs.partCutoff) - 10_000;
    await utimes(path, new Date(modified), new Date(modified));
  }
  const image = await createImage();
  const orphanFull = "orphan/full.webp";
  const orphanThumb = "orphan/thumb.webp";
  await access.driver.writeBuffer("full", orphanFull, Buffer.from("orphan"), "image/webp");
  await access.driver.writeBuffer("thumbs", orphanThumb, Buffer.from("orphan"), "image/webp");
  const before = await checkStorage();
  for (const key of [activeKey, activeCandidate, activeThumb]) assert.ok(before.active_staging_files.some(item => item.key === key));
  for (const key of [recentKey, unknownKey]) assert.ok(before.retained_staging_files.some(item => item.key === key));
  for (const key of [oldKey, oldCandidate]) assert.ok(before.orphan_staging_files.some(item => item.key === key));
  assert.ok(before.orphan_objects.some(item => item.key === orphanFull));
  assert.ok(before.orphan_thumbs.some(item => item.key === orphanThumb));
  assert.ok(before.missing_thumbs.some(item => item.id === image.id));
  assert.equal(before.stale_ingestion_raw_files.count, 1);
  assert.equal(before.stale_ingestion_part_files.count, 2);

  await leases.withActiveIngestionRawPaths([leasedPart], async () => {
    const report = await cleanupIngestionOrphans(now);
    assert.equal(report.skipped, false);
    assert.equal(report.staging_removed, 2);
    assert.equal(report.raw_removed, 2);
    assert.equal(report.staging_failed, 0);
    assert.equal(await readFile(leasedPart, "utf8"), "raw-data");
  });
  assert.equal((await cleanupIngestionOrphans(now)).raw_removed, 1);
  for (const key of [activeKey, activeCandidate, activeThumb, recentKey, unknownKey]) assert.equal(await access.driver.exists("_uploads", key), true, key);
  for (const path of [activeRaw, recentRaw]) assert.equal(await readFile(path, "utf8"), "raw-data");
  const maintained = (await maintainStorageAndPurgeTasks()).storage;
  assert.equal(maintained.failed, 0);
  assert.equal(maintained.items.find(item => item.image_id === image.id)?.outcome, "repaired");
  assert.equal(Number((await image.row()).thumbnail_size), (await access.driver.readBuffer("thumbs", image.thumb)).length);
  assert.equal(await access.driver.exists("full", orphanFull), false);
  assert.equal(await access.driver.exists("thumbs", orphanThumb), false);
  const repeated = (await maintainStorageAndPurgeTasks()).storage;
  assert.equal(repeated.repaired, 0);
  assert.equal(repeated.removed, 0);

  const bulkKeys = Array.from({ length: 205 }, () => makeKey(oldGeneration));
  for (const key of bulkKeys) await access.driver.writeBuffer("_uploads", key, Buffer.from("bulk"), "image/webp");
  const originalRemove = access.driver.removeObjects.bind(access.driver);
  const removalBatches: number[] = [];
  access.driver.removeObjects = async (objects, options) => {
    const count = objects.filter(object => bulkKeys.includes(object.key)).length;
    if (count) removalBatches.push(count);
    return originalRemove(objects, options);
  };
  try {
    assert.equal((await cleanupIngestionOrphans(now)).staging_removed, bulkKeys.length);
    assert.ok(removalBatches.length > 1);
    assert.ok(removalBatches.every(count => count <= 100));
    for (const key of bulkKeys) assert.equal(await access.driver.exists("_uploads", key), false);
  } finally { access.driver.removeObjects = originalRemove; }

  const incompleteKey = makeKey(oldGeneration);
  await access.driver.writeBuffer("_uploads", incompleteKey, Buffer.from("incomplete-list"), "image/webp");
  const originalList = access.driver.listKeys.bind(access.driver);
  access.driver.listKeys = (prefix, options) => prefix === "_uploads" ? (async function* () {
    yield [incompleteKey]; return { complete: false, count: 1, reason: "max_keys" as const };
  })() : originalList(prefix, options);
  try {
    const result = await cleanupIngestionOrphans(now);
    assert.ok(result.incomplete_namespaces > 0);
    assert.equal(result.staging_removed, 0);
    assert.equal(await access.driver.exists("_uploads", incompleteKey), true);
  } finally { access.driver.listKeys = originalList; }

  const rotationSlugs = ["orphan-rotation-a", "orphan-rotation-b", "orphan-rotation-c"];
  const rows = rotationSlugs.map(slug => ({ slug, config: { endpoint: "https://rotation.invalid", bucket: "rotation", root_path: slug,
    region: "auto", access_key_id: "fixture", secret_access_key: "fixture", force_path_style: true } }));
  await runtime.databasePools.pool.query("INSERT INTO storage_backend (slug, display_name, type, config, enabled) SELECT item->>'slug', item->>'slug','s3',item->'config',false FROM jsonb_array_elements($1::jsonb) item", [JSON.stringify(rows)]);
  runtime.storageRegistry.invalidateStorageBackendRegistry();
  const restoreBudget = installProperties(appConfig.ingestionRuntime, { orphanCleanupMaxStorageBackends: 2 });
  const visited = [new Set<string>(), new Set<string>()];
  let pass = 0;
  const rotationDrivers = await Promise.all(rotationSlugs.map(async slug => {
    const { driver } = await runtime.storageRegistry.resolveStorageAccess(slug);
    const original = driver.listKeys;
    driver.listKeys = () => {
      visited[pass]!.add(slug);
      return (async function* () { return { complete: true, count: 0 }; })();
    };
    return { driver, original };
  }));
  try {
    assert.ok((await cleanupIngestionOrphans(now)).incomplete_namespaces > 0);
    pass = 1;
    await cleanupIngestionOrphans(now);
    assert.ok([...visited[1]!].some(slug => !visited[0]!.has(slug)));
  } finally {
    for (const { driver, original } of rotationDrivers) driver.listKeys = original;
    restoreBudget();
    await runtime.databasePools.pool.query("DELETE FROM storage_backend WHERE slug=ANY($1::text[])", [rotationSlugs]);
    runtime.storageRegistry.invalidateStorageBackendRegistry();
    await scanner.closeIngestionRawCleanupCursor();
  }
});
