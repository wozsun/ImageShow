import type { PoolClient } from "pg";
import { nextSortOrderSql } from "../../core/database/sort-order-sql.ts";
import { readVocabularyMutationImpact } from "../mutation-impact.ts";
import { pool } from "../../core/database/pools.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  withVocabularyMutationSync,
  withVocabularyMutationLock
} from "../mutation-sync.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import {
  withImageMutationSync,
  type ImageMutationSyncBatch
} from "../../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../../images/ready-cache/revision.ts";

async function insertTheme(
  client: Pick<PoolClient, "query">,
  slug: string,
  displayName = ""
) {
  const result = await client.query(
    `INSERT INTO theme(slug, display_name, sort_order)
     VALUES($1, $2, ${nextSortOrderSql("theme")})
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug`,
    [slug, displayName]
  );
  return Boolean(result.rowCount);
}

/**
 * Use only while the caller owns vocabularyMutationLockKey("theme", slug).
 * This avoids acquiring the same advisory lock from the transaction client
 * after the caller's vocabulary/image compound lease is already held.
 */
export async function ensureThemeWithMutationLockHeld(
  client: PoolClient,
  slug: string
) {
  assertVocabularySlug("theme", slug);
  return insertTheme(client, slug);
}

export async function createTheme(slug: string, displayName: string) {
  assertVocabularySlug("theme", slug);

  await withVocabularyMutationLock("theme", slug, (signal) =>
    withVocabularyMutationSync("theme", async () => {
      signal.throwIfAborted();
      const inserted = await insertTheme(pool, slug, displayName);
      signal.throwIfAborted();
      assertVocabularyCreated("theme", slug, inserted ? 1 : 0);
    })
  );
}

export async function updateThemeDisplayName(slug: string, displayName: string) {
  await withVocabularyMutationSync("theme", async () => {
    const result = await pool.query(
      "UPDATE theme SET display_name = $2, updated_at = now() WHERE slug = $1",
      [slug, displayName]
    );
    assertVocabularyFound("theme", result.rowCount);
  });
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

    const { affectedCount, affected } = await readVocabularyMutationImpact(
      client,
      "theme",
      slug,
      mutationBatch,
      signal
    );
    await client.query(
      `UPDATE metadata SET theme=NULL, updated_at=now() WHERE theme=$1`,
      [slug]
    );
    signal.throwIfAborted();
    const deleted = Boolean(
      (await client.query(
        "DELETE FROM theme WHERE slug=$1",
        [slug]
      )).rowCount
    );
    if (affectedCount) await bumpReadyImageRevision(client);
    signal.throwIfAborted();
    return { deleted, affected };
  });
}

export async function deleteTheme(slug: string) {
  const result = await withVocabularyMutationLock("theme", slug, (signal) =>
    withImageMutationSync((mutationBatch) =>
      withVocabularyMutationSync("theme", async () => {
        const deleted = await deleteThemeUnderLock(slug, signal, mutationBatch);
        for (const image of deleted.affected) mutationBatch.add({ id: image.id });
        return deleted;
      })
    )
  );
  assertVocabularyFound("theme", result.deleted ? 1 : 0);
}
