import { slugPattern } from "@imageshow/shared";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { invalidateGalleryFacetsCache, invalidateImageReadCaches } from "../images/image-cache.ts";
import { applyOrCollectImageMutationSync, type ImageMutationSyncBatch } from "../images/mutation-sync.ts";
import { rebuildRandomPool } from "../random/random-cache.ts";
import {
  invalidateEntityCountCaches,
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCountCacheInvalidationBatch,
} from "../vocab/vocab-cache.ts";
import { resolveTagNames } from "./query.ts";

async function refreshTagDefinitionCaches(options: { facets?: boolean } = {}) {
  const tasks: Array<Promise<unknown>> = [
    refreshEntityVocabularies(["tag"]),
    invalidateEntityCountCaches(["tag"]),
  ];
  if (options.facets ?? true) tasks.push(invalidateGalleryFacetsCache());
  await Promise.all(tasks);
}

export async function upsertTag(slug: string, displayName = "") {
  if (slug.length > 32 || !slugPattern.test(slug)) {
    throw new ApiError(400, "invalid_tag", "Tag slug must be a lowercase slug (a-z, 0-9, -), <=32 chars", { slug });
  }

  await pool.query(
    `INSERT INTO tag(slug, display_name, sort_order)
     VALUES($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tag))
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
    [slug, displayName]
  );
  await refreshTagDefinitionCaches();
}

export async function reorderTags(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE tag t SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE t.slug = v.slug`,
    [slugs]
  );
  await refreshTagDefinitionCaches();
}

export async function deleteTags(slugs: string[]) {
  const targets = [...new Set(slugs)];
  if (!targets.length) return;
  const result = await pool.query("DELETE FROM tag WHERE slug = ANY($1::text[])", [targets]);
  if (result.rowCount) {
    await rebuildRandomPool();
    await Promise.all([
      invalidateImageReadCaches(),
      refreshTagDefinitionCaches({ facets: false }),
    ]);
  }
}

export async function setTagDisplayName(slug: string, displayName: string) {
  const result = await pool.query("UPDATE tag SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Tag not found");
  await refreshTagDefinitionCaches();
}

export async function deleteTag(slug: string) {
  const result = await pool.query("DELETE FROM tag WHERE slug = $1", [slug]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Tag not found");
  await rebuildRandomPool();
  await Promise.all([
    invalidateImageReadCaches(),
    refreshTagDefinitionCaches({ facets: false }),
  ]);
}

type SetImageTagsOptions = {
  entityCountInvalidationBatch?: EntityCountCacheInvalidationBatch;
  mutationSyncBatch?: ImageMutationSyncBatch;
};

export async function replaceImageTags(client: PoolClient, imageId: string, slugs: string[]) {
  const image = await client.query("SELECT md5 FROM metadata WHERE id = $1", [imageId]);
  if (!image.rowCount) throw new ApiError(404, "not_found", "Image not found");
  let createdTag = false;
  for (const slug of slugs) {
    const inserted = await client.query(
      `INSERT INTO tag(slug, sort_order)
       VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tag))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug]
    );
    if (inserted.rowCount) createdTag = true;
  }
  await client.query("DELETE FROM image_tag WHERE image_id = $1", [imageId]);
  for (const slug of slugs) {
    await client.query(
      "INSERT INTO image_tag(image_id, tag_slug) VALUES($1, $2) ON CONFLICT DO NOTHING",
      [imageId, slug]
    );
  }
  return {
    createdTag,
    md5: String(image.rows[0]?.md5 ?? ""),
  };
}

export async function setImageTags(imageId: string, names: string[], options: SetImageTagsOptions = {}) {
  const resolved = await resolveTagNames(names);
  const mutation = await withTransaction(async (client) => {
    return replaceImageTags(client, imageId, resolved);
  });

  // The database transaction has committed. Attempt every derived-cache
  // repair even if one cache backend operation fails, so callers never observe
  // tags committed without the random pool and MD5 detail cache being repaired.
  const cacheRepairs = await Promise.allSettled([
    applyOrCollectImageMutationSync({
      id: imageId,
      md5: mutation.md5,
    }, options.mutationSyncBatch),
    invalidateOrCollectEntityCountCaches(["tag"], options.entityCountInvalidationBatch),
    mutation.createdTag ? refreshEntityVocabularies(["tag"]) : Promise.resolve(),
  ]);
  const failedRepair = cacheRepairs.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failedRepair) throw failedRepair.reason;
}
