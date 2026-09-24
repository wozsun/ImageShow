import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { appConfig } from "../../../../packages/shared/src/app-config.ts";
import { installProperties } from "../../support/property-descriptors.ts";
import { interceptSqlQueries } from "./database-faults.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { createMaintenanceFixture, settleWithin } from "./storage-maintenance-fixture.mts";

await runIntegrationScenario(async (runtime) => {
  const { updateImages } = await import("../../../../packages/server/src/images/image-update.ts");
  const fixture = await createMaintenanceFixture(runtime);
  const count = appConfig.pgPool.max;
  const images: Array<Awaited<ReturnType<typeof fixture.createImage>>> = [];
  for (let index = 0; index < count * 2; index++) {
    images.push(await fixture.createImage({ thumbnail: fixture.body }));
  }
  const { getTagVocab } = await import("../../../../packages/server/src/vocab/vocab-cache.ts");
  await getTagVocab();

  // Keep real pool checkout and real PostgreSQL locks. Only synchronize the
  // first acquired image lock so every request owns its outer session first.
  const allRequestsEntered = Promise.withResolvers<void>();
  const entered = new Set<PoolClient>();
  let checkouts = 0;
  let active = 0;
  let maximumActive = 0;
  const originalConnect = pg.Pool.prototype.connect;
  const restoreConnect = installProperties(pg.Pool.prototype, {
    connect(this: pg.Pool, ...args: unknown[]) {
      const pending = Reflect.apply(originalConnect, this, args);
      if (
        this.options.application_name !== "imageshow-advisory-locks" ||
        typeof args.at(-1) === "function"
      )
        return pending;
      return (pending as Promise<PoolClient>).then((client) => {
        checkouts++;
        maximumActive = Math.max(maximumActive, ++active);
        const restoreQuery = interceptSqlQueries(client, async (sql, values, query) => {
          const result = await query();
          if (
            sql.includes("pg_advisory_lock(") &&
            Array.isArray(values) &&
            String(values[0]).startsWith("imageshow:image-update:") &&
            !entered.has(client)
          ) {
            entered.add(client);
            if (entered.size === count) allRequestsEntered.resolve();
            await allRequestsEntered.promise;
          }
          return result;
        });
        const release = client.release;
        const restoreRelease = installProperties(client, {
          release(destroy?: boolean | Error) {
            restoreQuery();
            restoreRelease();
            active--;
            release(destroy);
          }
        });
        return client;
      });
    }
  });
  const requests = Array.from({ length: count }, (_, index) =>
    updateImages([
      {
        id: images[index * 2]!.id,
        brightness: "auto",
        theme: "pool-theme",
        author: "pool-author",
        tags: ["pool-tag"]
      },
      { id: images[index * 2 + 1]!.id, device: "mb", tags: ["pool-tag", "pool-second"] }
    ])
  );
  let results;
  try {
    results = await settleWithin(Promise.all(requests), 20_000);
  } finally {
    allRequestsEntered.resolve();
    await Promise.allSettled(requests);
    restoreConnect();
  }
  assert.equal(entered.size, count);
  assert.deepEqual(
    results.map((result) => [result.updated, result.failed]),
    Array.from({ length: count }, () => [2, 0])
  );
  assert.equal(checkouts, count, "分类、词表与自动读取不得在请求持锁后再借锁连接");
  assert.equal(maximumActive, count);
  assert.equal(active, 0);
  assert.equal(
    (
      await runtime.databasePools.pool.query(
        "SELECT count(*)::int AS count FROM metadata WHERE theme='pool-theme' AND author='pool-author'"
      )
    ).rows[0].count,
    count
  );
  assert.equal(
    (
      await runtime.databasePools.pool.query(
        "SELECT count(*)::int AS count FROM image_tag WHERE tag_slug='pool-tag'"
      )
    ).rows[0].count,
    count * 2
  );

  const overlappingId = images[0]!.id;
  const completed: number[] = [];
  const overlapping = await settleWithin(
    Promise.all(
      Array.from({ length: count }, (_, index) =>
        updateImages([
          { id: overlappingId, title: `writer-${index}`, tags: [`writer-${index}`] }
        ]).then((result) => {
          completed.push(index);
          return result;
        })
      )
    ),
    20_000
  );
  assert.ok(overlapping.every((result) => result.updated === 1 && result.failed === 0));
  const last = completed.at(-1)!;
  const row = (
    await runtime.databasePools.pool.query(
      "SELECT title, ARRAY(SELECT tag_slug FROM image_tag WHERE image_id=metadata.id) AS tags FROM metadata WHERE id=$1",
      [overlappingId]
    )
  ).rows[0];
  assert.deepEqual(row, { title: `writer-${last}`, tags: [`writer-${last}`] });

  const partial = await updateImages([
    { id: randomUUID(), theme: "missing-image-theme", tags: ["missing-image-tag"] },
    { id: images[1]!.id, theme: "survivor", tags: ["survivor"] },
    { id: images[2]!.id, title: "following-group", tags: ["following-group"] }
  ]);
  assert.deepEqual(
    partial.results.map((item) => item.status),
    ["failed", "updated", "updated"]
  );
  assert.equal(partial.results[0]?.status === "failed" && partial.results[0].code, "not_found");
  assert.equal(
    (
      await runtime.databasePools.pool.query(
        "SELECT count(*)::int AS count FROM theme WHERE slug='missing-image-theme'"
      )
    ).rows[0].count,
    0
  );
  assert.equal((await updateImages([{ id: images[1]!.id, theme: null, tags: [] }])).updated, 1);
  console.log(
    JSON.stringify({
      scenario: "image-update-locking",
      requests: count,
      images: images.length,
      checkouts,
      maximumActive,
      active,
      overlapping: overlapping.length,
      partial: partial.results.map((item) => item.status)
    })
  );
});
