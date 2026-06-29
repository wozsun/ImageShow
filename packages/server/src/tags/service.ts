import { slugPattern } from "@imageshow/shared";
import { pool, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { invalidateTagVocab } from "../core/redis.js";
import type { Tag } from "./types.js";
import { resolveTagNames } from "./query.js";

// Get-or-create. The tag vocabulary is shared, so creating an existing slug
// updates its display name instead of erroring. Slugs are validated at the route.
export async function createTag(slug: string, displayName = ""): Promise<Tag> {
  if (slug.length > 32 || !slugPattern.test(slug)) {
    throw new ApiError(400, "invalid_tag", "Tag slug must be a lowercase slug (a-z, 0-9, -), <=32 chars", { slug });
  }
  // New tags append to the end of the manual order; re-creating one keeps its order.
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

// Persists the manual order: each given slug's sort_order becomes its list position.
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

// Batch delete; image_tag rows cascade, so the images simply lose these tags.
export async function deleteTags(slugs: string[]) {
  const targets = [...new Set(slugs)];
  if (!targets.length) return { deleted: 0 };
  const result = await pool.query("DELETE FROM tag WHERE slug = ANY($1::text[])", [targets]);
  await invalidateTagVocab();
  return { deleted: result.rowCount ?? 0 };
}

export async function setTagDisplayName(slug: string, displayName: string) {
  const result = await pool.query("UPDATE tag SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Tag not found");
  await invalidateTagVocab();
}

export async function deleteTag(slug: string) {
  const result = await pool.query("DELETE FROM tag WHERE slug = $1", [slug]); // image_tag rows cascade
  if (!result.rowCount) throw new ApiError(404, "not_found", "Tag not found");
  await invalidateTagVocab();
}

// Replaces an image's tag set with `names`, get-or-creating each tag. Returns the
// resulting slugs sorted. Runs in a transaction so a failure leaves tags intact.
export async function setImageTags(imageId: string, names: string[]): Promise<string[]> {
  // Resolve any aliases to their canonical tag slug before assigning, so tagging
  // by an alias attaches the real tag rather than creating a tag of the alias.
  const resolved = await resolveTagNames(names);
  await withTransaction(async (client) => {
    const image = await client.query("SELECT 1 FROM metadata WHERE id = $1", [imageId]);
    if (!image.rowCount) throw new ApiError(404, "not_found", "Image not found");
    for (const slug of resolved) {
      await client.query("INSERT INTO tag(slug, sort_order) VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tag)) ON CONFLICT (slug) DO NOTHING", [slug]);
    }
    await client.query("DELETE FROM image_tag WHERE image_id = $1", [imageId]);
    for (const slug of resolved) {
      await client.query("INSERT INTO image_tag(image_id, tag_slug) VALUES($1, $2) ON CONFLICT DO NOTHING", [imageId, slug]);
    }
  });
  // May have introduced new tag slugs and changed which tags are in use, so refresh
  // the tag vocabulary + gallery facets (the image read caches are dropped by callers).
  await invalidateTagVocab();
  return [...resolved].sort();
}
