import type { PoolClient } from "pg";
import { clampSortOrderSql, nextSortOrderSql } from "../../core/database/sort-order-sql.ts";
import { readVocabularyMutationImpact } from "../mutation-impact.ts";
import { pool } from "../../core/database/pools.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import { withImageMutationSync } from "../../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../../images/ready-cache/revision.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  withVocabularyMutationSync,
  withVocabularyMutationLock
} from "../mutation-sync.ts";

export async function createTag(slug: string, displayName = "", sortOrder?: number) {
  assertVocabularySlug("tag", slug);

  const result = await withVocabularyMutationLock("tag", slug, (signal) =>
    withVocabularyMutationSync("tag", async () => {
      signal.throwIfAborted();
      const created = await pool.query(
        `INSERT INTO tag(slug, display_name, sort_order)
       VALUES($1, $2, COALESCE($3::integer, ${nextSortOrderSql("tag")}))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
        [slug, displayName, sortOrder ?? null]
      );
      signal.throwIfAborted();
      return created;
    })
  );
  assertVocabularyCreated("tag", slug, result.rowCount);
}

export async function setTagDisplayName(slug: string, displayName: string) {
  await withVocabularyMutationSync("tag", async () => {
    const result = await pool.query(
      "UPDATE tag SET display_name = $2, updated_at = now() WHERE slug = $1",
      [slug, displayName]
    );
    assertVocabularyFound("tag", result.rowCount);
  });
}

export async function deleteTag(slug: string) {
  const result = await withVocabularyMutationLock("tag", slug, (signal) =>
    withImageMutationSync((mutationBatch) =>
      withVocabularyMutationSync("tag", async () => {
        const mutation = await withTransaction(async (client) => {
          signal.throwIfAborted();
          const { affectedCount, affected } = await readVocabularyMutationImpact(
            client,
            "tag",
            slug,
            mutationBatch,
            signal
          );
          const deleted = await client.query(
            "DELETE FROM tag WHERE slug = $1",
            [slug]
          );
          if (affectedCount) await bumpReadyImageRevision(client);
          signal.throwIfAborted();
          return { deleted, affected };
        });
        for (const image of mutation.affected) {
          mutationBatch.add({ id: image.id });
        }
        return mutation.deleted;
      })
    )
  );
  assertVocabularyFound("tag", result.rowCount);
}

/**
 * Replaces only the relational tag set. Callers that combine tags with other
 * image fields own the surrounding transaction and revision advance.
 */
export async function replaceImageTagAssociations(
  client: PoolClient,
  imageId: string,
  slugs: string[],
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const uniqueSlugs = [...new Set(slugs)];
  let createdTag = false;
  if (uniqueSlugs.length) {
    const inserted = await client.query(
      `WITH missing AS (
         SELECT input.slug, input.ord
           FROM unnest($1::text[]) WITH ORDINALITY AS input(slug, ord)
          WHERE NOT EXISTS (SELECT 1 FROM tag WHERE tag.slug = input.slug)
       )
       INSERT INTO tag(slug, sort_order)
       SELECT slug,
              ${clampSortOrderSql(`(SELECT COALESCE(MAX(sort_order), 0)::bigint FROM tag)
                + row_number() OVER (ORDER BY ord DESC)`)}
         FROM missing
        ORDER BY ord
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [uniqueSlugs]
    );
    if (inserted.rowCount) createdTag = true;
  }
  signal?.throwIfAborted();
  await client.query("DELETE FROM image_tag WHERE image_id = $1", [imageId]);
  if (uniqueSlugs.length) {
    signal?.throwIfAborted();
    await client.query(
      `INSERT INTO image_tag(image_id, tag_slug)
       SELECT $1, slug FROM unnest($2::text[]) AS input(slug)
       ON CONFLICT DO NOTHING`,
      [imageId, uniqueSlugs]
    );
  }
  signal?.throwIfAborted();
  return { createdTag };
}
