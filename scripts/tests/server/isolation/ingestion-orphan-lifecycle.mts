import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { activeSession, createIngestionScenarioFixture } from "./ingestion-scenario-fixture.mts";
import { createMaintenanceFixture } from "./storage-maintenance-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const fixture = await createIngestionScenarioFixture(runtime);
  const { access, createImage } = await createMaintenanceFixture(runtime);
  const { randomUuidV7 } = await import("../../../../packages/server/src/core/uuid.ts");
  const identity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
  const { ingestionSessionSemanticHash } = await import("../../../../packages/server/src/images/ingestion/sessions/projection.ts");
  const { semanticIngestionSession } = await import("../../../../packages/server/src/images/ingestion/sessions/transitions.ts");
  const paths = await import("../../../../packages/server/src/images/ingestion/raw/paths.ts");
  const leases = await import("../../../../packages/server/src/images/ingestion/raw/lease-registry.ts");
  const { ingestionOrphanCutoffs } = await import("../../../../packages/server/src/images/ingestion/cleanup/retention.ts");
  const { cleanupIngestionOrphans } = await import("../../../../packages/server/src/images/ingestion/cleanup/orphans.ts");
  const { checkStorage } = await import("../../../../packages/server/src/checks/storage-check.ts");
  const { maintainStorageAndPurgeTasks } = await import("../../../../packages/server/src/checks/storage-maintenance.ts");
  const now = Date.now();
  const cutoffs = ingestionOrphanCutoffs(now);
  const pair = { session_id: identity.createIngestionSessionId("orphan-owner", "import", "active"), image_id: randomUuidV7() };
  const generation = randomUuidV7();
  const makePrepared = (kind: "image" | "thumb" = "image") => paths.ingestionPreparedFile({
    ...pair, generation, execution_token: randomUuidV7()
  }, kind);
  const activeImage = makePrepared();
  const activeThumb = makePrepared("thumb");
  const orphanPrepared = paths.ingestionPreparedPath(makePrepared());
  const orphanPreparedPart = paths.ingestionPreparedPath(makePrepared()) + ".part";
  const recentPrepared = paths.ingestionPreparedPath(makePrepared());
  const template = { ...fixture.importTemplate, ...pair, owner: "orphan-owner", image_time: new Date(now).toISOString() };
  const queued = activeSession((await fixture.ingestionRepository.acceptImportSession({ ...template,
    semantic_hash: ingestionSessionSemanticHash(template) }, fixture.displayOrderKey(pair.session_id, 0, now), now)).session);
  await fixture.ingestionRepository.mutateSemantic(queued, queued.version, semanticIngestionSession(queued, {
    status: "ready", phase: "ready", raw_generation: generation, raw_size: 8,
    prepared: { ...fixture.preparedTemplate, generation, prepared_image_path: activeImage, prepared_thumbnail_path: activeThumb }
  }));
  const activeRaw = paths.ingestionRawPath(pair, generation);
  const orphanRaw = paths.ingestionRawPath(pair, randomUuidV7());
  const recentRaw = paths.ingestionRawPath(pair, randomUuidV7());
  const orphanPart = paths.ingestionRawPartPath(pair, randomUuidV7(), randomUuidV7());
  const leasedPart = paths.ingestionRawPartPath(pair, randomUuidV7(), randomUuidV7());
  const retained = [activeRaw, recentRaw, recentPrepared, paths.ingestionPreparedPath(activeImage), paths.ingestionPreparedPath(activeThumb)];
  const disposable = [orphanRaw, orphanPart, leasedPart, orphanPrepared, orphanPreparedPart];
  for (const path of [...retained, ...disposable]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "raw-data");
    const modified = path === recentRaw || path === recentPrepared ? now : Math.min(cutoffs.fileCutoff, cutoffs.partCutoff) - 10_000;
    await utimes(path, new Date(modified), new Date(modified));
  }
  const image = await createImage();
  const orphanFull = "orphan/full.webp";
  const orphanThumb = "orphan/thumb.webp";
  await access.driver.writeBuffer("full", orphanFull, Buffer.from("orphan"), "image/webp");
  await access.driver.writeBuffer("thumbs", orphanThumb, Buffer.from("orphan"), "image/webp");
  const before = await checkStorage();
  assert.ok(before.orphan_objects.some(item => item.key === orphanFull));
  assert.ok(before.orphan_thumbs.some(item => item.key === orphanThumb));
  assert.ok(before.missing_thumbs.some(item => item.id === image.id));
  assert.equal(before.stale_ingestion_raw_files.count, 1);
  assert.equal(before.stale_ingestion_part_files.count, 3);
  assert.equal(before.stale_ingestion_prepared_files.count, 1);
  assert.deepEqual(before.ingestion_temp_space, { total_bytes: 80, retained_bytes: 24, complete: true });

  await leases.withActiveIngestionTempPaths([leasedPart], async () => {
    const report = await cleanupIngestionOrphans(now);
    assert.deepEqual(report, { skipped: false, temp_removed: 4, incomplete_temp_scans: 0 });
    assert.equal(await readFile(leasedPart, "utf8"), "raw-data");
  });
  assert.equal((await cleanupIngestionOrphans(now)).temp_removed, 1);
  for (const path of retained) assert.equal(await readFile(path, "utf8"), "raw-data");
  for (const path of disposable) await assert.rejects(readFile(path), { code: "ENOENT" });
  const after = await checkStorage();
  assert.deepEqual(after.ingestion_temp_space, { total_bytes: 40, retained_bytes: 24, complete: true });
  const maintained = (await maintainStorageAndPurgeTasks()).storage;
  assert.equal(maintained.failed, 0);
  assert.equal(maintained.items.find(item => item.image_id === image.id)?.outcome, "repaired");
  assert.equal(Number((await image.row()).thumbnail_size), (await access.driver.readBuffer("thumbs", image.thumb)).length);
  assert.equal(await access.driver.exists("full", orphanFull), false);
  assert.equal(await access.driver.exists("thumbs", orphanThumb), false);
  const repeated = (await maintainStorageAndPurgeTasks()).storage;
  assert.equal(repeated.repaired, 0);
  assert.equal(repeated.removed, 0);
});
