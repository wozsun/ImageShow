import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  runIntegrationScenario
} from "./integration-runtime.mts";

type AdminImagesReadModelModule = typeof import(
  "../../../../packages/server/src/images/read-models/admin-images.ts"
);
type CoreUuidModule = typeof import(
  "../../../../packages/server/src/core/uuid.ts"
);
type ImageFilterPlanModule = typeof import(
  "../../../../packages/server/src/images/filter-plan.ts"
);
type ImagePathsModule = typeof import(
  "../../../../packages/server/src/storage/objects/image-paths.ts"
);
type PublicImagesReadModelModule = typeof import(
  "../../../../packages/server/src/images/read-models/public-images.ts"
);
type PublicUrlsModule = typeof import(
  "../../../../packages/server/src/storage/objects/public-urls.ts"
);
type ReadyCacheCoordinatorModule = typeof import(
  "../../../../packages/server/src/images/ready-cache/coordinator.ts"
);
type ReadyCacheFilterIndexModule = typeof import(
  "../../../../packages/server/src/images/ready-cache/indexes/filter.ts"
);
type RuntimeAvailabilityModule = typeof import(
  "../../../../packages/server/src/core/runtime-availability.ts"
);
type VocabCacheModule = typeof import(
  "../../../../packages/server/src/vocab/vocab-cache.ts"
);

await runIntegrationScenario(async (runtime) => {
  const adminImages = await import(
    runtime.moduleUrl("packages/server/src/images/read-models/admin-images.ts")
  ) as AdminImagesReadModelModule;
  const publicImages = await import(
    runtime.moduleUrl("packages/server/src/images/read-models/public-images.ts")
  ) as PublicImagesReadModelModule;
  const imagePaths = await import(
    runtime.moduleUrl("packages/server/src/storage/objects/image-paths.ts")
  ) as ImagePathsModule;
  const publicUrls = await import(
    runtime.moduleUrl("packages/server/src/storage/objects/public-urls.ts")
  ) as PublicUrlsModule;
  const coreUuid = await import(
    runtime.moduleUrl("packages/server/src/core/uuid.ts")
  ) as CoreUuidModule;
  const filterPlan = await import(
    runtime.moduleUrl("packages/server/src/images/filter-plan.ts")
  ) as ImageFilterPlanModule;
  const filterIndex = await import(
    runtime.moduleUrl("packages/server/src/images/ready-cache/indexes/filter.ts")
  ) as ReadyCacheFilterIndexModule;
  const coordinator = await import(
    runtime.moduleUrl("packages/server/src/images/ready-cache/coordinator.ts")
  ) as ReadyCacheCoordinatorModule;
  const runtimeAvailability = await import(
    runtime.moduleUrl("packages/server/src/core/runtime-availability.ts")
  ) as RuntimeAvailabilityModule;
  const vocabCache = await import(
    runtime.moduleUrl("packages/server/src/vocab/vocab-cache.ts")
  ) as VocabCacheModule;

  const suffix = randomUUID().slice(0, 8);
  const theme = `cache-theme-${suffix}`;
  const tag = `cache-tag-${suffix}`;
  const author = `cache-author-${suffix}`;
  const imageDate = new Date("2026-09-07T01:00:00.000Z");
  const imageIds = [
    coreUuid.randomUuidV7At(imageDate, 1),
    coreUuid.randomUuidV7At(imageDate, 2),
    coreUuid.randomUuidV7At(imageDate, 3)
  ];
  const expectedOrder = [...imageIds].sort().reverse();
  const errors: unknown[] = [];
  try {
    await runtime.databasePools.pool.query(
      "INSERT INTO theme(slug, display_name) VALUES($1, 'Cache theme')",
      [theme]
    );
    await runtime.databasePools.pool.query(
      "INSERT INTO tag(slug, display_name) VALUES($1, 'Cache tag')",
      [tag]
    );
    await runtime.databasePools.pool.query(
      "INSERT INTO author(slug, display_name) VALUES($1, 'Cache author')",
      [author]
    );
    for (const [position, imageId] of imageIds.entries()) {
      await runtime.databasePools.pool.query(
        "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, "
          + "device, brightness, theme, ext, md5, author, image_time, title) "
          + "VALUES($1,'integration-admin','ready','local',$2,$3,$4,$5,'webp',"
          + "$6,$7,$8,$9)",
        [
          imageId,
          imagePaths.storageObjectKey(imageId, "webp"),
          position === 1 ? "mb" : "pc",
          position === 2 ? "light" : "dark",
          theme,
          createHash("md5").update(imageId).digest("hex"),
          author,
          imageDate,
          `cache item ${position}`
        ]
      );
      await runtime.databasePools.pool.query(
        "INSERT INTO image_tag(image_id, tag_slug) VALUES($1,$2)",
        [imageId, tag]
      );
    }
    await vocabCache.refreshEntityVocabularies(["theme", "tag", "author"]);
    await runtimeAvailability.requireOperationalRedis();
    await runtime.runtimeConfigStore.updateRuntimeConfig({
      site: { domain: "images.example" }
    });
    const displayed = await publicUrls.publicImageUrls(
      imagePaths.storageObjectKey(imageIds[2], "webp"), "local"
    );
    await runtime.databasePools.pool.query(
      "UPDATE metadata SET original=$2, source=$3 WHERE id=$1",
      [imageIds[0], "https://original.example.com/image.jpg", "https://source.example.com/post"]
    );
    await runtime.databasePools.pool.query(
      "UPDATE metadata SET original=$2 WHERE id=$1",
      [imageIds[2], `${displayed.object_url}#original`]
    );
    // Before the ready projection is initialized, detail reads use PostgreSQL.
    const databaseDetails = await Promise.all(imageIds.map((id) => (
      publicImages.getPublicImage(id)
    )));
    assert.equal(databaseDetails[0].original_url, `https://images.example/images/link/${imageIds[0]}`);
    assert.equal(databaseDetails[1].original_url, null);
    assert.equal(databaseDetails[2].original_url, null);
    assert.deepEqual(databaseDetails.map((item) => item.source), [
      "https://source.example.com/post", null, null
    ]);
    await coordinator.initializeReadyImageCacheCoordinator();
    await coordinator.requestReadyImageCacheRebuild();
    assert.equal(coordinator.getReadyImageCacheCoordinatorStatus().readable, true);
    const plan = await filterPlan.resolveImageFilterPlan(
      { theme, tag, author },
      { redisMode: "required" }
    );
    assert.ok(await filterIndex.resolveReadyImageFilterIndex(plan));
    const adminPage = await adminImages.listAdminImages({
      status: "ready",
      theme,
      tag,
      author,
      page: 1,
      limit: 10
    });
    assert.deepEqual(adminPage.items.map((item) => item.id), expectedOrder);
    assert.equal(adminPage.total, 3);
    const cachedDetails = await Promise.all(imageIds.map((id) => (
      publicImages.getPublicImage(id)
    )));
    assert.deepEqual(cachedDetails, databaseDetails);
    const snapshots = await adminImages.getAdminImageSnapshots(imageIds);
    assert.deepEqual(
      snapshots.items.map((item) => item.original_url),
      databaseDetails.map((item) => item.original_url)
    );
    assert.deepEqual(
      snapshots.items.map((item) => item.source),
      databaseDetails.map((item) => item.source)
    );
    for (const item of adminPage.items) {
      assert.equal(item.original_url, databaseDetails.find((detail) => (
        detail.id === item.id
      ))?.original_url);
      assert.equal(item.source, databaseDetails.find((detail) => (
        detail.id === item.id
      ))?.source);
    }
    const publicPage = await publicImages.listPublicImages({
      status: "ready",
      view: "gallery",
      theme,
      tag,
      author,
      order: "latest",
      limit: 10
    }, new AbortController().signal);
    assert.deepEqual(publicPage.items.map((item) => item.id), expectedOrder);
    assert.equal(publicPage.next_cursor, null);
    await runtime.databasePools.pool.query(
      "UPDATE metadata SET status='deleted', deleted_at=now() WHERE id=$1",
      [imageIds[0]]
    );
    const deletedPage = await adminImages.listAdminImages({
      status: "deleted", theme, page: 1, limit: 10
    });
    assert.equal(deletedPage.items.length, 1);
    assert.equal(
      deletedPage.items[0].original_url,
      `/api/admin/images/${imageIds[0]}/original`
    );
    assert.equal(deletedPage.items[0].object_url, databaseDetails[0].object_url);
  } catch (error) {
    errors.push(error);
  }
  const cleanupSteps: Array<() => Promise<unknown>> = [
    () => runtime.databasePools.pool.query(
      "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
      [imageIds]
    ),
    () => runtime.databasePools.pool.query("DELETE FROM tag WHERE slug=$1", [tag]),
    () => runtime.databasePools.pool.query("DELETE FROM theme WHERE slug=$1", [theme]),
    () => runtime.databasePools.pool.query("DELETE FROM author WHERE slug=$1", [author]),
    () => vocabCache.refreshEntityVocabularies(["theme", "tag", "author"]),
    () => coordinator.requestReadyImageCacheRebuild()
  ];
  for (const cleanup of cleanupSteps) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "ready-cache scenario and cleanup failed");
  }
});
