import { pool } from "../core/db.js";
import { getAuthorVocab } from "../core/redis.js";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.js";
import type { Author } from "./types.js";

// Term → canonical author slug, and term-list → deduped slug list, over the cached
// author vocabulary (see core/term-resolve for the shared resolution rules). The author
// vocab carries an extra `link`, ignored here.
export function resolveAuthorTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getAuthorVocab, terms);
}

export function resolveAuthorSlugs(terms: string[]): Promise<string[]> {
  return resolveSlugs(getAuthorVocab, terms);
}

// Full author registry for the management page: display name, link, how many ready images
// currently use each slug, and the manual sort order. There is no 'none' sentinel — an
// unassigned image simply has a NULL author.
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
