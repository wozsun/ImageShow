import { pool } from "../core/db.js";
import { getAuthorVocab } from "../vocab/vocab-cache.js";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.js";
import type { Author } from "./types.js";

export function resolveAuthorTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getAuthorVocab, terms);
}

export function resolveAuthorSlugs(terms: string[]): Promise<string[]> {
  return resolveSlugs(getAuthorVocab, terms);
}

export async function listAuthorsWithMeta(): Promise<Author[]> {
  return (await pool.query(
    `SELECT a.slug,
            a.display_name,
            a.link,
            (SELECT count(*)::int FROM metadata m WHERE m.author = a.slug AND m.status = 'ready') AS image_count
     FROM author a
     ORDER BY a.sort_order ASC, a.slug ASC`
  )).rows as Author[];
}
