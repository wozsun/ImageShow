import { sortOrderMin, sortOrderMax } from "@imageshow/shared/browser";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AdminSession } from "../../../../packages/server/src/users/admin-session.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { interceptSqlQueries, withCommitFault } from "./database-faults.mts";

await runIntegrationScenario(async (runtime) => {
  const tags = await import("../../../../packages/server/src/tags/mutations.ts");
  const themes = await import("../../../../packages/server/src/themes/mutations.ts");
  const authors = await import("../../../../packages/server/src/authors/mutations.ts");
  const vocab = await import("../../../../packages/server/src/vocab/vocab-cache.ts");
  const { setVocabularySortOrder } =
    await import("../../../../packages/server/src/vocab/sort-order.ts");
  const { registerAdminVocabularyRoutes } =
    await import("../../../../packages/server/src/routes/admin-vocabulary.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const { ApiError } = await import("../../../../packages/server/src/core/api-error.ts");
  const { requireAdminCsrf } =
    await import("../../../../packages/server/src/users/admin-session.ts");
  const { getPublicGalleryStats } =
    await import("../../../../packages/server/src/images/read-models/gallery-stats.ts");
  const { updateImages } = await import("../../../../packages/server/src/images/image-update.ts");
  const { moveImagesToTrash, restoreImages } =
    await import("../../../../packages/server/src/images/trash/mutations.ts");

  const { pool } = runtime.databasePools;
  const entities = [
    {
      kind: "tag",
      field: "tags",
      create: (slug: string) => tags.createTag(slug),
      list: vocab.getAdminTagList
    },
    {
      kind: "theme",
      field: "themes",
      create: (slug: string) => themes.createTheme(slug, ""),
      list: vocab.getAdminThemeList
    },
    {
      kind: "author",
      field: "authors",
      create: (slug: string) => authors.createAuthor(slug, "", ""),
      list: vocab.getAdminAuthorList
    }
  ] as const;
  const app = new Hono<{ Variables: { session: AdminSession } }>();
  app.onError((error, context) => handleApiError(context, error));
  app.use("/api/admin/*", async (context, next) => {
    const role = context.req.header("x-role");
    if (role !== "image" && role !== "super")
      throw new ApiError(401, "unauthorized", "Authentication required");
    context.set("session", {
      id: "sort-session",
      username: "integration-admin",
      role,
      csrf: "sort-csrf"
    });
    await next();
  });
  app.use("/api/admin/*", async (context, next) => {
    if (context.req.method !== "GET") return requireAdminCsrf(context, next);
    await next();
  });
  registerAdminVocabularyRoutes(app as unknown as Hono);
  const write = (field: string, slug: string, body: unknown, role = "image", csrf = "sort-csrf") =>
    app.request(`/api/admin/${field}/${slug}/sort-order`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-role": role, "x-csrf-token": csrf },
      body: JSON.stringify(body)
    });
  const slugs = (items: readonly { slug: string }[]) => items.map((item) => item.slug);
  const imageId = randomUUID();
  await pool.query(
    `INSERT INTO metadata(id, created_by, status, storage_slug, device, brightness, ext, md5)
       VALUES ($1, 'integration-admin', 'ready', 'local', 'pc', 'dark', 'webp', $2)`,
    [imageId, "1".repeat(32)]
  );
  try {
    await assert.rejects(themes.createTheme("null", ""), { status: 400, code: "invalid_theme" });
    const invalidThemeUpdate = await updateImages([{ id: imageId, theme: "null" }]);
    assert.equal(invalidThemeUpdate.updated, 0);
    assert.equal(invalidThemeUpdate.failed, 1);
    assert.equal(
      (await pool.query("SELECT theme FROM metadata WHERE id=$1", [imageId])).rows[0].theme,
      null
    );
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM theme")).rows[0].count, 0);
    for (const entity of entities) {
      await entity.create("order-first");
      await entity.create("order-second");
      assert.deepEqual(slugs(await entity.list()), ["order-second", "order-first"], entity.kind);
      const secondBefore = (await entity.list()).find((item) => item.slug === "order-second")!;
      await setVocabularySortOrder(entity.kind, "order-first", 10);
      assert.deepEqual(
        (await entity.list()).find((item) => item.slug === "order-second"),
        secondBefore
      );
      await entity.create("order-third");
      assert.deepEqual(
        slugs(await entity.list()),
        ["order-third", "order-first", "order-second"],
        entity.kind
      );
      await assert.rejects(entity.create("order-first"), { status: 409 });
      assert.deepEqual(
        slugs(await entity.list()),
        ["order-third", "order-first", "order-second"],
        "duplicate must not move an existing entry"
      );
    }
    const update = {
      id: imageId,
      theme: "order-auto",
      author: "order-auto",
      tags: ["order-new-a", "order-first", "order-new-b", "order-new-a"]
    };
    assert.equal((await updateImages([update])).updated, 1);
    const expected = {
      tags: ["order-new-a", "order-new-b", "order-third", "order-first", "order-second"],
      themes: ["order-auto", "order-third", "order-first", "order-second"],
      authors: ["order-auto", "order-third", "order-first", "order-second"]
    };
    for (const entity of entities) {
      assert.deepEqual(slugs(await entity.list()), expected[entity.field]);
      assert.deepEqual(
        slugs((await vocab.getIngestionVocabulary())[entity.field]),
        entity.kind === "theme" ? ["null", ...expected.themes] : expected[entity.field]
      );
    }
    assert.equal((await updateImages([update])).updated, 1);
    for (const entity of entities) {
      assert.deepEqual(
        slugs(await entity.list()),
        expected[entity.field],
        "reusing vocabulary must preserve order"
      );
      await Promise.all([entity.create("order-concurrent-a"), entity.create("order-concurrent-b")]);
      const current = slugs(await entity.list());
      assert.deepEqual(current.slice(0, 2).sort(), ["order-concurrent-a", "order-concurrent-b"]);
      assert.deepEqual(current.slice(2), expected[entity.field]);
    }
    for (const entity of entities) {
      for (const role of ["image", "super"]) {
        assert.equal(
          (await write(entity.field, "order-second", { sort_order: -7 }, role)).status,
          200
        );
      }
      await setVocabularySortOrder(entity.kind, "order-first", -7);
      const ordered = await entity.list();
      assert.deepEqual(
        ordered.slice(-2).map((item) => [item.slug, item.sort_order]),
        [
          ["order-first", -7],
          ["order-second", -7]
        ]
      );
      const snapshot = (await pool.query(`SELECT * FROM ${entity.kind} ORDER BY slug`)).rows;
      for (const body of [
        {},
        { sort_order: "4" },
        { sort_order: 1.2 },
        { sort_order: sortOrderMax + 1 },
        { sort_order: sortOrderMin - 1 },
        { sort_order: 4, extra: true }
      ]) {
        assert.equal((await write(entity.field, "order-first", body)).status, 400);
      }
      assert.equal((await write(entity.field, "order-first", { sort_order: 0 }, "")).status, 401);
      assert.equal(
        (await write(entity.field, "order-first", { sort_order: 0 }, "image", "wrong")).status,
        403
      );
      assert.equal((await write(entity.field, "order-missing", { sort_order: 0 })).status, 404);
      assert.deepEqual(
        (await pool.query(`SELECT * FROM ${entity.kind} ORDER BY slug`)).rows,
        snapshot
      );
      for (const sort_order of [sortOrderMin, sortOrderMax]) {
        assert.equal((await write(entity.field, "order-first", { sort_order })).status, 200);
        const listResponse = await app.request(`/api/admin/${entity.field}`, {
          headers: { "x-role": "image" }
        });
        assert.equal(listResponse.status, 200);
        const { items } = await listResponse.json();
        assert.equal(
          items.find((item: { slug: string }) => item.slug === "order-first").sort_order,
          sort_order
        );
        assert.equal(
          (await entity.list()).find((item) => item.slug === "order-second")!.sort_order,
          -7
        );
      }
      await entity.create("order-max-a");
      await entity.create("order-max-b");
      assert.deepEqual(
        (await entity.list()).slice(0, 3).map((item) => [item.slug, item.sort_order]),
        [
          ["order-first", sortOrderMax],
          ["order-max-a", sortOrderMax],
          ["order-max-b", sortOrderMax]
        ]
      );
      const stats = await getPublicGalleryStats();
      const expectedOrder = slugs(await entity.list());
      const visible = (items: readonly { slug: string }[]) =>
        slugs(items).filter((slug) => slug !== "null");
      assert.deepEqual(
        visible((await vocab.getIngestionVocabulary())[entity.field]),
        expectedOrder
      );
      const populated = entity.kind === "tag" ? update.tags : ["order-auto"];
      assert.deepEqual(
        visible(stats[entity.field]),
        expectedOrder.filter((slug) => populated.includes(slug))
      );
    }
    for (const baseline of [
      -2_147_483_648,
      sortOrderMin - 1_000_000,
      sortOrderMin,
      sortOrderMax,
      2_147_483_647
    ]) {
      for (const entity of entities) {
        await pool.query(`UPDATE ${entity.kind} SET sort_order=$1`, [baseline]);
        const before = (
          await pool.query(`SELECT slug, sort_order FROM ${entity.kind} ORDER BY slug`)
        ).rows;
        const slug = `order-bound-${baseline}`;
        await entity.create(slug);
        assert.equal(
          (await pool.query(`SELECT sort_order FROM ${entity.kind} WHERE slug=$1`, [slug])).rows[0]
            .sort_order,
          Math.max(sortOrderMin, Math.min(sortOrderMax, baseline + 1))
        );
        assert.deepEqual(
          (
            await pool.query(
              `SELECT slug, sort_order FROM ${entity.kind} WHERE slug<>$1 ORDER BY slug`,
              [slug]
            )
          ).rows,
          before,
          "creation preserves existing out-of-range records"
        );
        await pool.query(`DELETE FROM ${entity.kind} WHERE slug=$1`, [slug]);
      }
      const auto = `order-bound-auto-${baseline}`;
      assert.equal(
        (
          await updateImages([
            {
              id: imageId,
              theme: auto,
              author: auto,
              tags: [`${auto}-a`, `${auto}-b`, `${auto}-a`]
            }
          ])
        ).updated,
        1
      );
      for (const entity of entities) {
        const added = (
          await pool.query(
            `SELECT slug, sort_order FROM ${entity.kind} WHERE slug LIKE $1 ORDER BY slug`,
            [`${auto}%`]
          )
        ).rows;
        const clamp = (increment: number) =>
          Math.max(sortOrderMin, Math.min(sortOrderMax, baseline + increment));
        assert.deepEqual(
          added.map((row) => row.sort_order),
          entity.kind === "tag" ? [clamp(2), clamp(1)] : [clamp(1)]
        );
        assert.ok(
          (
            await pool.query(`SELECT sort_order FROM ${entity.kind} WHERE slug NOT LIKE $1`, [
              `${auto}%`
            ])
          ).rows.every((row) => row.sort_order === baseline),
          "association creation preserves existing values"
        );
      }
    }
    const countSlug = "order-count";
    assert.equal(
      (
        await updateImages([
          {
            id: imageId,
            theme: countSlug,
            author: countSlug,
            tags: [countSlug]
          }
        ])
      ).updated,
      1
    );
    const assertAssociationCounts = async () => {
      for (const entity of entities) {
        assert.equal(
          (await entity.list()).find((item) => item.slug === countSlug)?.image_count,
          1,
          entity.kind
        );
      }
    };
    await assertAssociationCounts();
    assert.equal((await moveImagesToTrash([imageId])).trashed, 1);
    await assertAssociationCounts();
    await vocab.invalidateEntityCountCaches(["theme", "tag", "author"]);
    await assertAssociationCounts();
    assert.equal(
      (await authors.updateAuthorProfile(countSlug, "Includes trash", "")).image_count,
      1
    );
    assert.equal(
      (await getPublicGalleryStats()).total_images,
      0,
      "public counts only include ready images"
    );
    assert.equal((await restoreImages([imageId])).restored, 1);
    await assertAssociationCounts();
    assert.equal((await getPublicGalleryStats()).total_images, 1);
    assert.equal((await moveImagesToTrash([imageId])).trashed, 1);
    await themes.deleteTheme(countSlug);
    await authors.deleteAuthor(countSlug);
    await tags.deleteTag(countSlug);
    const unlinked = (
      await pool.query("SELECT status, theme, author FROM metadata WHERE id=$1", [imageId])
    ).rows[0];
    assert.deepEqual(unlinked, { status: "deleted", theme: null, author: null });
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS count FROM image_tag WHERE image_id=$1", [
          imageId
        ])
      ).rows[0].count,
      0
    );

    for (const entity of entities) {
      await entity.list();
      await vocab.getIngestionVocabulary();
      let responseLost = false;
      const restoreQuery = interceptSqlQueries(pool, async (sql, values, query) => {
        const result = await query();
        if (
          !responseLost &&
          sql.startsWith(`UPDATE ${entity.kind} SET sort_order=`) &&
          Array.isArray(values) &&
          values[0] === "order-first"
        ) {
          responseLost = true;
          throw new Error("controlled vocabulary write acknowledgement loss");
        }
        return result;
      });
      try {
        await assert.rejects(
          setVocabularySortOrder(entity.kind, "order-first", 123),
          /controlled vocabulary write acknowledgement loss/
        );
      } finally {
        restoreQuery();
      }
      assert.equal(responseLost, true);
      assert.equal(
        (await entity.list()).find((item) => item.slug === "order-first")?.sort_order,
        123
      );
      assert.deepEqual(
        slugs((await vocab.getIngestionVocabulary())[entity.field]).filter(
          (slug) => slug !== "null"
        ),
        slugs(await entity.list()),
        "the public vocabulary must reflect the committed order"
      );
    }
    let injectCommitLoss = true;
    await assert.rejects(
      withCommitFault(
        pool,
        "committed",
        async () => {
          await authors.createAuthor("order-uncertain", "", "");
        },
        undefined,
        () => {
          if (!injectCommitLoss) return false;
          injectCommitLoss = false;
          return true;
        }
      ),
      /controlled commit acknowledgement loss/
    );
    assert.equal(injectCommitLoss, false);
    assert.ok((await vocab.getAdminAuthorList()).some((item) => item.slug === "order-uncertain"));
    assert.ok(
      (await vocab.getIngestionVocabulary()).authors.some((item) => item.slug === "order-uncertain")
    );
    console.log(
      "vocabulary order: ordering, routes, all-image association counts and lost commit acknowledgements passed"
    );
  } finally {
    await pool.query("DELETE FROM metadata WHERE id=$1", [imageId]);
    for (const entity of entities)
      await pool.query(`DELETE FROM ${entity.kind} WHERE slug LIKE 'order-%'`);
  }
});
