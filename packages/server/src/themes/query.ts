import { pool } from "../core/db.ts";
import { getThemeVocab } from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { Theme } from "./types.ts";

export function resolveThemeTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getThemeVocab, terms);
}

export function resolveThemeSlugs(terms: string[]): Promise<string[]> {
  return resolveSlugs(getThemeVocab, terms);
}

export async function listThemesWithMeta(): Promise<Theme[]> {
  return (await pool.query(
    `SELECT t.slug,
            t.display_name,
            (SELECT count(*)::int FROM metadata m WHERE m.theme = t.slug AND m.status = 'ready') AS image_count
     FROM theme t
     ORDER BY (t.slug = 'none') DESC, t.sort_order ASC, t.slug ASC`
  )).rows as Theme[];
}
