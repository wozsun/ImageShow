import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const tags = await import("../../../../packages/server/src/tags/mutations.ts");
  const themes = await import("../../../../packages/server/src/themes/mutations.ts");
  const authors = await import("../../../../packages/server/src/authors/mutations.ts");
  const vocab = await import("../../../../packages/server/src/vocab/vocab-cache.ts");
  const { updateImages } = await import("../../../../packages/server/src/images/image-update.ts");
  const { storageObjectKey } = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
  const { pool } = runtime.databasePools;
  const entities = [
    { kind: "tag", field: "tags", create: (slug: string) => tags.createTag(slug), reorder: tags.reorderTags, list: vocab.getAdminTagList },
    { kind: "theme", field: "themes", create: (slug: string) => themes.createTheme(slug, ""), reorder: themes.reorderThemes, list: vocab.getAdminThemeList },
    { kind: "author", field: "authors", create: (slug: string) => authors.createAuthor(slug, "", ""), reorder: authors.reorderAuthors, list: vocab.getAdminAuthorList }
  ] as const;
  const slugs = (items: readonly { slug: string }[]) => items.map(item => item.slug);
  const imageId = randomUUID();
  await pool.query(`INSERT INTO metadata(id,created_by,status,storage_slug,object_key,device,brightness,ext,md5)
    VALUES($1,'integration-admin','ready','local',$2,'pc','dark','webp',$3)`,
  [imageId, storageObjectKey(imageId, "webp"), "1".repeat(32)]);
  try {
    await assert.rejects(themes.createTheme("null", ""), { status: 400, code: "invalid_theme" });
    const invalidThemeUpdate = await updateImages([{ id: imageId, theme: "null" }]);
    assert.equal(invalidThemeUpdate.updated, 0);
    assert.equal(invalidThemeUpdate.failed, 1);
    assert.equal((await pool.query("SELECT theme FROM metadata WHERE id=$1", [imageId])).rows[0].theme, null);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM theme")).rows[0].count, 0);
    for (const entity of entities) {
      await entity.create("order-first");
      await entity.create("order-second");
      assert.deepEqual(slugs(await entity.list()), ["order-second", "order-first"], entity.kind);
      await entity.reorder(["order-first", "order-second"]);
      await entity.create("order-third");
      assert.deepEqual(slugs(await entity.list()), ["order-third", "order-first", "order-second"], entity.kind);
      await assert.rejects(entity.create("order-first"), { status: 409 });
      assert.deepEqual(slugs(await entity.list()), ["order-third", "order-first", "order-second"], "duplicate must not move an existing entry");
    }
    const update = { id: imageId, theme: "order-auto", author: "order-auto", tags: ["order-new-a", "order-first", "order-new-b", "order-new-a"] };
    assert.equal((await updateImages([update])).updated, 1);
    const expected = {
      tags: ["order-new-a", "order-new-b", "order-third", "order-first", "order-second"],
      themes: ["order-auto", "order-third", "order-first", "order-second"],
      authors: ["order-auto", "order-third", "order-first", "order-second"]
    };
    for (const entity of entities) {
      assert.deepEqual(slugs(await entity.list()), expected[entity.field]);
      assert.deepEqual(slugs((await vocab.getIngestionVocabulary())[entity.field]),
        entity.kind === "theme" ? ["null", ...expected.themes] : expected[entity.field]);
    }
    assert.equal((await updateImages([update])).updated, 1);
    for (const entity of entities) {
      assert.deepEqual(slugs(await entity.list()), expected[entity.field], "reusing vocabulary must preserve order");
      await Promise.all([entity.create("order-concurrent-a"), entity.create("order-concurrent-b")]);
      const current = slugs(await entity.list());
      assert.deepEqual(current.slice(0, 2).sort(), ["order-concurrent-a", "order-concurrent-b"]);
      assert.deepEqual(current.slice(2), expected[entity.field]);
    }
    console.log("vocabulary order: explicit creation, manual reorder, automatic creation, batch order, reuse and concurrency passed");
  } finally {
    await pool.query("DELETE FROM metadata WHERE id=$1", [imageId]);
    for (const entity of entities) await pool.query(`DELETE FROM ${entity.kind} WHERE slug LIKE 'order-%'`);
  }
});
