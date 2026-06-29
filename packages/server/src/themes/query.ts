import { pool } from "../core/db.js";
import { getThemeVocab } from "../core/redis.js";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.js";
import type { Theme } from "./types.js";

// Term → canonical theme slug, and term-list → deduped slug list, over the cached
// theme vocabulary (see core/term-resolve for the shared resolution rules).
export function resolveThemeTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getThemeVocab, terms);
}

export function resolveThemeSlugs(terms: string[]): Promise<string[]> {
  return resolveSlugs(getThemeVocab, terms);
}

// Full theme registry for the management page: display name, how many ready images
// currently use each slug, and the manual sort order. The reserved 'none' sentinel
// (unassigned theme) is included but pinned first and shown as '未设置'; the page makes
// it non-deletable / non-draggable.
export async function listThemesWithMeta(): Promise<Theme[]> {
  return (await pool.query(
    `SELECT t.slug,
            t.display_name,
            (SELECT count(*)::int FROM metadata m WHERE m.theme = t.slug AND m.status = 'ready') AS image_count
     FROM theme t
     ORDER BY (t.slug = 'none') DESC, t.sort_order ASC, t.slug ASC`
  )).rows as Theme[];
}
