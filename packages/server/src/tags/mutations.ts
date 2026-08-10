import type { PoolClient } from "pg";
import { pool } from "../core/database-pools.ts";
import { withTransaction } from "../core/database-transactions.ts";
import { ApiError } from "../core/api-error.ts";
import {
  withImageMutationSync
} from "../images/mutation-sync.ts";
import { bumpReadyImageRevision } from "../images/ready-cache/revision.ts";
import {
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCountCacheInvalidationBatch,
} from "../vocab/vocab-cache.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  synchronizeVocabularyMutation,
  withVocabularyAssociationLocks,
  withVocabularyMutationLock
} from "../vocab/mutation-sync.ts";
import { resolveTagNames } from "./query.ts";

export async function createTag(slug: string, displayName = "") {
  assertVocabularySlug("tag", slug);

  const result = await withVocabularyMutationLock("tag", slug, async (signal) => {
    signal.throwIfAborted();
    const created = await pool.query(
      `INSERT INTO tag(slug, display_name, sort_order)
       VALUES($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tag))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug, displayName]
    );
    signal.throwIfAborted();
    return created;
  });
  assertVocabularyCreated("tag", slug, result.rowCount);
  await synchronizeVocabularyMutation({ entity: "tag" });
}

export async function reorderTags(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE tag t SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE t.slug = v.slug`,
    [slugs]
  );
  await synchronizeVocabularyMutation({ entity: "tag" });
}

export async function setTagDisplayName(slug: string, displayName: string) {
  const result = await pool.query("UPDATE tag SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  assertVocabularyFound("tag", result.rowCount);
  await synchronizeVocabularyMutation({ entity: "tag" });
}

export async function deleteTag(slug: string) {
  const result = await withVocabularyMutationLock(
    "tag",
    slug,
    (signal) => withImageMutationSync(async (mutationBatch) => {
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
      await Promise.all([
        refreshEntityVocabularies(["tag"]),
        invalidateOrCollectEntityCountCaches(["tag"])
      ]);
      return mutation.deleted;
    })
  );
  assertVocabularyFound("tag", result.rowCount);
}

type SetImageTagsOptions = {
  entityCountInvalidationBatch?: EntityCountCacheInvalidationBatch;
};

export async function replaceImageTags(
  client: PoolClient,
  imageId: string,
  slugs: string[],
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const image = await client.query("SELECT md5 FROM metadata WHERE id = $1", [imageId]);
  if (!image.rowCount) throw new ApiError(404, "not_found", "Image not found");
  let createdTag = false;
  for (const slug of slugs) {
    signal?.throwIfAborted();
    const inserted = await client.query(
      `INSERT INTO tag(slug, sort_order)
       VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tag))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug]
    );
    if (inserted.rowCount) createdTag = true;
  }
  await bumpReadyImageRevision(client);
  signal?.throwIfAborted();
  await client.query("DELETE FROM image_tag WHERE image_id = $1", [imageId]);
  for (const slug of slugs) {
    signal?.throwIfAborted();
    await client.query(
      "INSERT INTO image_tag(image_id, tag_slug) VALUES($1, $2) ON CONFLICT DO NOTHING",
      [imageId, slug]
    );
  }
  signal?.throwIfAborted();
  return {
    createdTag,
    md5: String(image.rows[0]?.md5 ?? ""),
  };
}

export async function updateImageTags(imageId: string, names: string[], options: SetImageTagsOptions = {}) {
  const resolved = await resolveTagNames(names);
  const persist = (signal?: AbortSignal) => withImageMutationSync(
    async (mutationBatch) => {
      const mutation = await withTransaction(async (client) => {
        signal?.throwIfAborted();
        const result = await replaceImageTags(client, imageId, resolved, signal);
        signal?.throwIfAborted();
        return result;
      });
      mutationBatch.add({ id: imageId });
      const cacheRepairs = await Promise.allSettled([
        invalidateOrCollectEntityCountCaches(
          ["tag"],
          options.entityCountInvalidationBatch
        ),
        mutation.createdTag
          ? refreshEntityVocabularies(["tag"])
          : Promise.resolve()
      ]);
      const failedRepair = cacheRepairs.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failedRepair) throw failedRepair.reason;
    }
  );
  return resolved.length
    ? withVocabularyAssociationLocks(
      resolved.map((slug) => ({ entity: "tag", slug })),
      (signal) => persist(signal)
    )
    : persist();
}
