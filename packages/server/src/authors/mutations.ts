import type { Pool, PoolClient } from "pg";
import { pool, withTransaction } from "../core/db.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  synchronizeVocabularyMutation,
  withVocabularyMutationLock
} from "../vocab/mutation-sync.ts";

/** Use only while the caller owns a shared association or exclusive mutation lock. */
export async function ensureAuthorWithMutationLockHeld(
  client: Pool | PoolClient,
  slug: string
) {
  if (!slug) return false;
  const result = await client.query(
    `INSERT INTO author(slug, sort_order)
     VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM author))
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug`,
    [slug]
  );
  return Boolean(result.rowCount);
}

export async function createAuthor(slug: string, displayName: string, link: string) {
  assertVocabularySlug("author", slug);

  const result = await withVocabularyMutationLock("author", slug, async (signal) => {
    signal.throwIfAborted();
    const created = await pool.query(
      `INSERT INTO author(slug, display_name, link, sort_order)
       VALUES($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM author))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug, displayName, link]
    );
    signal.throwIfAborted();
    return created;
  });
  assertVocabularyCreated("author", slug, result.rowCount);
  await synchronizeVocabularyMutation({ entity: "author" });
}

export async function updateAuthorProfile(slug: string, displayName: string, link: string) {
  const result = await pool.query("UPDATE author SET display_name = $2, link = $3, updated_at = now() WHERE slug = $1", [slug, displayName, link]);
  assertVocabularyFound("author", result.rowCount);
  await synchronizeVocabularyMutation({ entity: "author" });
}

export async function reorderAuthors(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE author a SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE a.slug = v.slug`,
    [slugs]
  );
  await synchronizeVocabularyMutation({ entity: "author" });
}

type ClearedAuthorImage = { id: string; object_key: string };

async function deleteAuthorUnderLock(slug: string, signal: AbortSignal) {
  return withTransaction(async (client) => {
    signal.throwIfAborted();
    const author = await client.query(
      "SELECT slug FROM author WHERE slug=$1 FOR UPDATE",
      [slug]
    );
    signal.throwIfAborted();
    if (!author.rowCount) {
      return { deleted: false, affected: [] as ClearedAuthorImage[] };
    }
    const affected = (await client.query(
      `UPDATE metadata
          SET author=NULL, updated_at=now()
        WHERE author=$1
        RETURNING id, object_key`,
      [slug]
    )).rows as ClearedAuthorImage[];
    signal.throwIfAborted();
    const deleted = Boolean((await client.query(
      "DELETE FROM author WHERE slug=$1",
      [slug]
    )).rowCount);
    signal.throwIfAborted();
    return { deleted, affected };
  });
}

async function synchronizeAuthorDeletion(affected: ClearedAuthorImage[]) {
  await synchronizeVocabularyMutation({
    entity: "author",
    lookupEntries: affected,
    imageDataChanged: Boolean(affected.length),
    random: { mode: "images", ids: affected.map((image) => image.id) }
  });
}

export async function deleteAuthor(slug: string) {
  const result = await withVocabularyMutationLock(
    "author",
    slug,
    (signal) => deleteAuthorUnderLock(slug, signal)
  );
  assertVocabularyFound("author", result.deleted ? 1 : 0);
  await synchronizeAuthorDeletion(result.affected);
}

export async function deleteAuthors(slugs: string[]) {
  const targets = [...new Set(slugs)];
  if (!targets.length) return;
  const affected: ClearedAuthorImage[] = [];
  let deletedAny = false;
  for (const slug of targets) {
    const result = await withVocabularyMutationLock(
      "author",
      slug,
      (signal) => deleteAuthorUnderLock(slug, signal)
    );
    affected.push(...result.affected);
    deletedAny = result.deleted || deletedAny;
  }
  if (deletedAny) await synchronizeAuthorDeletion(affected);
}
