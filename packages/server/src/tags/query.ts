import { pool } from "../core/db.js";
import { getTagVocab } from "../vocab/vocab-cache.js";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.js";
import type { Tag } from "./types.js";

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

export async function listTagsWithCounts(): Promise<Tag[]> {
  return (await pool.query(
    `SELECT t.slug, t.display_name,
            (SELECT count(*)::int FROM image_tag it WHERE it.tag_slug = t.slug) AS image_count
     FROM tag t
     ORDER BY t.sort_order ASC, t.slug ASC`
  )).rows as Tag[];
}

export function resolveTagTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getTagVocab, terms);
}

export function resolveTagNames(names: string[]): Promise<string[]> {
  return resolveSlugs(getTagVocab, names);
}
