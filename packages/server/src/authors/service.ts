import type { Pool, PoolClient } from "pg";
import { slugPattern } from "@imageshow/shared";
import { pool } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { invalidateAuthorVocab, invalidateImageReadCaches } from "../core/redis.js";

// Registers an author slug so it becomes manageable (display name + link). A no-op for an
// empty slug ("" = no author) or an already-registered one. New slugs append to the end of
// the manual order. Takes a Pool or a transaction's PoolClient — the category-move edit path
// ensures inside its transaction, while an author-only edit ensures straight on the pool.
export async function ensureAuthor(client: Pool | PoolClient, slug: string) {
  if (!slug) return;
  await client.query(
    "INSERT INTO author(slug, sort_order) VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM author)) ON CONFLICT (slug) DO NOTHING",
    [slug]
  );
}

export async function createAuthor(slug: string, displayName: string, link: string) {
  if (slug.length > 32 || !slugPattern.test(slug)) {
    throw new ApiError(400, "invalid_author", "Author slug must be a lowercase slug (a-z, 0-9, -), <=32 chars", { slug });
  }
  // New authors append to the end of the manual order; re-creating an existing slug only
  // refreshes its display name + link (sort_order untouched).
  await pool.query(
    `INSERT INTO author(slug, display_name, link, sort_order)
     VALUES($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM author))
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, link = EXCLUDED.link, updated_at = now()`,
    [slug, displayName, link]
  );
  await invalidateAuthorVocab();
}

// Sets an author's display name and link together (the management card edits both).
export async function setAuthorMeta(slug: string, displayName: string, link: string) {
  const result = await pool.query("UPDATE author SET display_name = $2, link = $3, updated_at = now() WHERE slug = $1", [slug, displayName, link]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Author not found");
  await invalidateAuthorVocab();
}

// Persists the manual order: each given slug's sort_order becomes its position in the list.
export async function reorderAuthors(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE author a SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE a.slug = v.slug`,
    [slugs]
  );
  await invalidateAuthorVocab();
}

// True when any image (any status) still references `slug`. Author isn't part of category_key,
// so deletion needs no re-index/folder-map rebuild — only an image read-cache refresh when the
// FK's ON DELETE SET NULL actually cleared some rows.
async function authorHasImages(slug: string): Promise<boolean> {
  return Boolean((await pool.query("SELECT 1 FROM metadata WHERE author=$1 LIMIT 1", [slug])).rowCount);
}

export async function deleteAuthor(slug: string) {
  const exists = (await pool.query("SELECT 1 FROM author WHERE slug=$1", [slug])).rowCount;
  if (!exists) throw new ApiError(404, "not_found", "Author not found");
  // The FK's ON DELETE SET NULL clears this author off its images automatically; check first
  // so we only bust the read caches when something actually changed.
  const cleared = await authorHasImages(slug);
  await pool.query("DELETE FROM author WHERE slug = $1", [slug]);
  await invalidateAuthorVocab();
  if (cleared) await invalidateImageReadCaches();
}

// Batch delete: drop the authors (ON DELETE SET NULL clears them off their images), then
// refresh the image read caches once if any deletion cleared an image.
export async function deleteAuthors(slugs: string[]) {
  const targets = [...new Set(slugs)];
  if (!targets.length) return { deleted: 0 };
  let cleared = false;
  let deleted = 0;
  for (const slug of targets) {
    if (!(await pool.query("SELECT 1 FROM author WHERE slug=$1", [slug])).rowCount) continue;
    if (await authorHasImages(slug)) cleared = true;
    deleted += (await pool.query("DELETE FROM author WHERE slug=$1", [slug])).rowCount ?? 0;
  }
  await invalidateAuthorVocab();
  if (cleared) await invalidateImageReadCaches();
  return { deleted };
}
