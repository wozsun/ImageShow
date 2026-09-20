import { sortOrderMin, sortOrderMax } from "@imageshow/shared/browser";
import type { PoolClient } from "pg";
import { pool } from "../core/database/pools.ts";
import { withTransaction } from "../core/database/transactions.ts";
import { ApiError } from "../core/api-error.ts";
import {
  withImageMutationSync
} from "../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../images/ready-cache/revision.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  withVocabularyMutationSync,
  withVocabularyMutationLock
} from "../vocab/mutation-sync.ts";

export async function createTag(slug: string, displayName = "") {
  assertVocabularySlug("tag", slug);

  const result = await withVocabularyMutationLock("tag", slug, (signal) => withVocabularyMutationSync("tag", async () => {
    signal.throwIfAborted();
    const created = await pool.query(
      `INSERT INTO tag(slug, display_name, sort_order)
       VALUES($1, $2, (
         SELECT GREATEST(${sortOrderMin}, LEAST(COALESCE(MAX(sort_order), 0)::bigint + 1, ${sortOrderMax}))
         FROM tag
       ))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug, displayName]
    );
    signal.throwIfAborted();
    return created;
  }));
  assertVocabularyCreated("tag", slug, result.rowCount);
}

export async function setTagDisplayName(slug: string, displayName: string) {
  await withVocabularyMutationSync("tag", async () => {
    const result = await pool.query("UPDATE tag SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
    assertVocabularyFound("tag", result.rowCount);
  });
}

export async function deleteTag(slug: string) {
  const result = await withVocabularyMutationLock(
    "tag",
    slug,
    (signal) => withImageMutationSync((mutationBatch) => withVocabularyMutationSync("tag", async () => {
      const mutation = await withTransaction(async (client) => {
        signal.throwIfAborted();
        const affectedCount = Number((await client.query(
          `SELECT count(*)::int AS count
             FROM metadata m
             JOIN image_tag it ON it.image_id=m.id
            WHERE it.tag_slug=$1
              AND m.status='ready'`,
          [slug]
        )).rows[0]?.count ?? 0);
        signal.throwIfAborted();
        const decision = mutationBatch.decide(affectedCount);
        const affected = decision.mode === "exact"
          ? (await client.query(
            `SELECT m.id
               FROM metadata m
               JOIN image_tag it ON it.image_id=m.id
              WHERE it.tag_slug=$1
                AND m.status='ready'
              ORDER BY m.id`,
            [slug]
          )).rows as Array<{ id: string }>
          : [];
        signal.throwIfAborted();
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
    }))
  );
  assertVocabularyFound("tag", result.rowCount);
}

export async function replaceImageTags(
  client: PoolClient,
  imageId: string,
  slugs: string[],
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const image = await client.query("SELECT md5 FROM metadata WHERE id = $1", [imageId]);
  if (!image.rowCount) throw new ApiError(404, "not_found", "Image not found");
  const { createdTag } = await replaceImageTagAssociations(
    client,
    imageId,
    slugs,
    signal
  );
  await bumpReadyImageRevision(client);
  signal?.throwIfAborted();
  return {
    createdTag,
    md5: String(image.rows[0]?.md5 ?? ""),
  };
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
              GREATEST(${sortOrderMin}, LEAST(
                (SELECT COALESCE(MAX(sort_order), 0)::bigint FROM tag)
                  + row_number() OVER (ORDER BY ord DESC), ${sortOrderMax}))
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
