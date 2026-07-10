import { slugPattern } from "@imageshow/shared";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { invalidateImageReadCaches } from "../images/image-cache.ts";
import { rebuildRandomPool, syncRandomImage } from "../random/random-cache.ts";
import { invalidateTagVocab } from "../vocab/vocab-cache.ts";
import type { Tag } from "./types.ts";
import { resolveTagNames } from "./query.ts";

export async function upsertTag(slug: string, displayName = ""): Promise<Tag> {
  if (slug.length > 32 || !slugPattern.test(slug)) {
    throw new ApiError(400, "invalid_tag", "Tag slug must be a lowercase slug (a-z, 0-9, -), <=32 chars", { slug });
  }

  const tag = (await pool.query(
    `INSERT INTO tag(slug, display_name, sort_order)
     VALUES($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tag))
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING slug, display_name,
               (SELECT count(*)::int FROM image_tag it WHERE it.tag_slug = tag.slug) AS image_count`,
    [slug, displayName]
  )).rows[0] as Tag;
  await invalidateTagVocab();
  return tag;
}

export async function reorderTags(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE tag t SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE t.slug = v.slug`,
    [slugs]
  );
  await invalidateTagVocab();
}

export async function deleteTags(slugs: string[]) {
  const targets = [...new Set(slugs)];
  if (!targets.length) return { deleted: 0 };
  const result = await pool.query("DELETE FROM tag WHERE slug = ANY($1::text[])", [targets]);
  await invalidateTagVocab();
  if (result.rowCount) {
    await rebuildRandomPool();
    await invalidateImageReadCaches();
  }
  return { deleted: result.rowCount ?? 0 };
}

export async function setTagDisplayName(slug: string, displayName: string) {
  const result = await pool.query("UPDATE tag SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Tag not found");
  await invalidateTagVocab();
  await invalidateImageReadCaches();
}

export async function deleteTag(slug: string) {
  const result = await pool.query("DELETE FROM tag WHERE slug = $1", [slug]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Tag not found");
  await invalidateTagVocab();
  await rebuildRandomPool();
  await invalidateImageReadCaches();
}

type SetImageTagsOptions = {
  syncRandom?: boolean;
  invalidate?: boolean;
};

export async function replaceImageTags(client: PoolClient, imageId: string, slugs: string[]) {
  const image = await client.query("SELECT 1 FROM metadata WHERE id = $1", [imageId]);
  if (!image.rowCount) throw new ApiError(404, "not_found", "Image not found");
  for (const slug of slugs) {
    await client.query(
      "INSERT INTO tag(slug, sort_order) VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tag)) ON CONFLICT (slug) DO NOTHING",
      [slug]
    );
  }
  await client.query("DELETE FROM image_tag WHERE image_id = $1", [imageId]);
  for (const slug of slugs) {
    await client.query(
      "INSERT INTO image_tag(image_id, tag_slug) VALUES($1, $2) ON CONFLICT DO NOTHING",
      [imageId, slug]
    );
  }
}

export async function setImageTags(imageId: string, names: string[], options: SetImageTagsOptions = {}): Promise<string[]> {
  const resolved = await resolveTagNames(names);
  await withTransaction(async (client) => {
    await replaceImageTags(client, imageId, resolved);
  });

  await invalidateTagVocab();
  if (options.syncRandom ?? true) await syncRandomImage(imageId);
  if (options.invalidate ?? true) await invalidateImageReadCaches();
  return [...resolved].sort();
}
