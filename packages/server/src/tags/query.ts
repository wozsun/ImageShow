import { pool } from "../core/db.js";
import { getTagVocab } from "../core/redis.js";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.js";
import type { Tag } from "./types.js";

// Tag slugs for a batch of image ids, as image_id -> sorted slugs. Done in one
// query per page so image lists don't fan out into a tag lookup per row. The slug
// is stored directly on image_tag, so no join is needed.
export async function getTagsForImages(ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const rows = (await pool.query(
    `SELECT image_id, tag_slug AS slug
     FROM image_tag
     WHERE image_id = ANY($1::uuid[])
     ORDER BY tag_slug ASC`,
    [ids]
  )).rows as Array<{ image_id: string; slug: string }>;
  for (const row of rows) {
    const list = map.get(row.image_id);
    if (list) list.push(row.slug);
    else map.set(row.image_id, [row.slug]);
  }
  return map;
}

// The full tag vocabulary with how many images carry each tag — backs the tag
// management page and the admin tag typeahead.
export async function listTagsWithCounts(): Promise<Tag[]> {
  return (await pool.query(
    `SELECT t.slug, t.display_name,
            (SELECT count(*)::int FROM image_tag it WHERE it.tag_slug = t.slug) AS image_count
     FROM tag t
     ORDER BY t.sort_order ASC, t.slug ASC`
  )).rows as Tag[];
}

// Term → canonical tag slug, and term-list → deduped slug list, over the cached tag
// vocabulary (see core/term-resolve for the shared resolution rules).
export function resolveTagTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getTagVocab, terms);
}

export function resolveTagNames(names: string[]): Promise<string[]> {
  return resolveSlugs(getTagVocab, names);
}
