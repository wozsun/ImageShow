import { pool } from "../core/db.ts";
import { getAdminTagList, getTagVocab } from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { Tag } from "./types.ts";

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
  return getAdminTagList();
}

export function resolveTagTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getTagVocab, terms);
}

export function resolveTagNames(names: string[]): Promise<string[]> {
  return resolveSlugs(getTagVocab, names);
}
