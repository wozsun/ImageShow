import type { PoolClient } from "pg";
import { pool } from "../core/database/pools.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  synchronizeVocabularyMutation,
  withVocabularyMutationLock
} from "../vocab/mutation-sync.ts";
import { withTransaction } from "../core/database/transactions.ts";
import {
  withImageMutationSync,
  type ImageMutationSyncBatch
} from "../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../images/ready-cache/revision.ts";

async function insertTheme(client: PoolClient, slug: string) {
  if (!slug) return false;
  assertVocabularySlug("theme", slug);
  const result = await client.query(
    `INSERT INTO theme(slug, sort_order)
     VALUES($1, (SELECT LEAST(COALESCE(MAX(sort_order), 0)::bigint + 1, 2147483647) FROM theme))
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug`,
    [slug]
  );
  return Boolean(result.rowCount);
}

/**
 * Use only while the caller owns vocabularyMutationLockKey("theme", slug).
 * This avoids acquiring the same advisory lock from the transaction client
 * after the caller's vocabulary/image compound lease is already held.
 */
export function ensureThemeWithMutationLockHeld(
  client: PoolClient,
  slug: string
) {
  return insertTheme(client, slug);
}

export async function createTheme(slug: string, displayName: string) {
  assertVocabularySlug("theme", slug);

  await withVocabularyMutationLock("theme", slug, async (signal) => {
    signal.throwIfAborted();
    const result = await pool.query(
      `INSERT INTO theme(slug, display_name, sort_order)
       VALUES($1, $2, (SELECT LEAST(COALESCE(MAX(sort_order), 0)::bigint + 1, 2147483647) FROM theme))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug, displayName]
    );
    signal.throwIfAborted();
    assertVocabularyCreated("theme", slug, result.rowCount);
  });
  await synchronizeVocabularyMutation({ entity: "theme" });
}

export async function updateThemeDisplayName(slug: string, displayName: string) {
  const result = await pool.query("UPDATE theme SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  assertVocabularyFound("theme", result.rowCount);
  await synchronizeVocabularyMutation({ entity: "theme" });
}

async function deleteThemeUnderLock(
  slug: string,
  signal: AbortSignal,
  mutationBatch: ImageMutationSyncBatch
) {
  return withTransaction(async (client) => {
    signal.throwIfAborted();
    const theme = await client.query(
      "SELECT slug FROM theme WHERE slug=$1 FOR UPDATE",
      [slug]
    );
    signal.throwIfAborted();
    if (!theme.rowCount) return { deleted: false, affected: [] as { id: string }[] };

    const affectedCount = Number((await client.query(
      `SELECT count(*)::int AS count
         FROM metadata
        WHERE theme=$1 AND status='ready'`,
      [slug]
    )).rows[0]?.count ?? 0);
    signal.throwIfAborted();
    const decision = mutationBatch.decide(affectedCount);
    const affected = decision.mode === "exact"
      ? (await client.query<{ id: string }>(
          `SELECT id FROM metadata
            WHERE theme=$1 AND status='ready'
            ORDER BY id`,
          [slug]
        )).rows
      : [];
    signal.throwIfAborted();
    await client.query(
      `UPDATE metadata SET theme=NULL, updated_at=now() WHERE theme=$1`,
      [slug]
    );
    signal.throwIfAborted();
    const deleted = Boolean((await client.query(
      "DELETE FROM theme WHERE slug=$1",
      [slug]
    )).rowCount);
    if (affectedCount) await bumpReadyImageRevision(client);
    signal.throwIfAborted();
    return { deleted, affected };
  });
}

export async function deleteTheme(slug: string) {
  const result = await withVocabularyMutationLock(
    "theme",
    slug,
    (signal) => withImageMutationSync(async (mutationBatch) => {
      try {
        const deleted = await deleteThemeUnderLock(slug, signal, mutationBatch);
        for (const image of deleted.affected) mutationBatch.add({ id: image.id });
        return deleted;
      } finally {
        // A lost COMMIT acknowledgement does not prove rollback. Refresh from
        // database truth while the vocabulary lease and cache fence still hold.
        await synchronizeVocabularyMutation({ entity: "theme" });
      }
    })
  );
  assertVocabularyFound("theme", result.deleted ? 1 : 0);
}
