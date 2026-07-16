import type { Pool, PoolClient } from "pg";
import { slugPattern } from "@imageshow/shared";
import { pool } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { invalidateGalleryFacetsCache, invalidateImageReadCaches } from "../images/image-cache.ts";
import { rebuildRandomPool } from "../random/random-cache.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies,
} from "../vocab/vocab-cache.ts";

export async function ensureAuthor(client: Pool | PoolClient, slug: string) {
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

async function refreshAuthorDefinitionCaches(options: { facets?: boolean } = {}) {
  const tasks: Array<Promise<unknown>> = [
    refreshEntityVocabularies(["author"]),
    invalidateEntityCountCaches(["author"]),
  ];
  if (options.facets ?? true) tasks.push(invalidateGalleryFacetsCache());
  await Promise.all(tasks);
}

export async function upsertAuthor(slug: string, displayName: string, link: string) {
  if (slug.length > 32 || !slugPattern.test(slug)) {
    throw new ApiError(400, "invalid_author", "Author slug must be a lowercase slug (a-z, 0-9, -), <=32 chars", { slug });
  }

  await pool.query(
    `INSERT INTO author(slug, display_name, link, sort_order)
     VALUES($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM author))
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, link = EXCLUDED.link, updated_at = now()`,
    [slug, displayName, link]
  );
  await refreshAuthorDefinitionCaches();
}

export async function setAuthorMeta(slug: string, displayName: string, link: string) {
  const result = await pool.query("UPDATE author SET display_name = $2, link = $3, updated_at = now() WHERE slug = $1", [slug, displayName, link]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Author not found");
  await refreshAuthorDefinitionCaches();
}

export async function reorderAuthors(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE author a SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE a.slug = v.slug`,
    [slugs]
  );
  await refreshAuthorDefinitionCaches();
}

async function authorHasImages(slug: string): Promise<boolean> {
  return Boolean((await pool.query("SELECT 1 FROM metadata WHERE author=$1 LIMIT 1", [slug])).rowCount);
}

export async function deleteAuthor(slug: string) {
  const exists = (await pool.query("SELECT 1 FROM author WHERE slug=$1", [slug])).rowCount;
  if (!exists) throw new ApiError(404, "not_found", "Author not found");

  const cleared = await authorHasImages(slug);
  await pool.query("DELETE FROM author WHERE slug = $1", [slug]);
  if (cleared) {
    await rebuildRandomPool();
    await Promise.all([
      invalidateImageReadCaches(),
      refreshAuthorDefinitionCaches({ facets: false }),
    ]);
  } else await refreshAuthorDefinitionCaches();
}

export async function deleteAuthors(slugs: string[]) {
  const targets = [...new Set(slugs)];
  if (!targets.length) return;
  let cleared = false;
  let deletedAny = false;
  for (const slug of targets) {
    if (!(await pool.query("SELECT 1 FROM author WHERE slug=$1", [slug])).rowCount) continue;
    if (await authorHasImages(slug)) cleared = true;
    const result = await pool.query("DELETE FROM author WHERE slug=$1", [slug]);
    deletedAny = Boolean(result.rowCount) || deletedAny;
  }
  if (cleared) {
    await rebuildRandomPool();
    await Promise.all([
      invalidateImageReadCaches(),
      refreshAuthorDefinitionCaches({ facets: false }),
    ]);
  } else if (deletedAny) await refreshAuthorDefinitionCaches();
}
