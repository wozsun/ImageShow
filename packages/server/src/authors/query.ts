import {
  getAdminAuthorList,
  getAuthorVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { pool } from "../core/database/pools.ts";
import { resolveVocabularySlugs, resolveTermSlugMap } from "../vocab/terms.ts";
import type { AuthorDto } from "@imageshow/shared/browser";
import { isWeiboUserId } from "./identity.ts";

export function resolveAuthorTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermSlugMap(() => getAuthorVocab(access), terms);
}

export function resolveAuthorSlugs(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  return resolveVocabularySlugs(() => getAuthorVocab(access), terms);
}

export async function listAuthorsWithMeta(): Promise<AuthorDto[]> {
  return getAdminAuthorList();
}

export async function resolveWeiboAuthorSlugs(
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  const uniqueUserIds = [...new Set(userIds)].filter(isWeiboUserId);
  if (!uniqueUserIds.length) return new Map();
  const rows = (await pool.query<{
    identity_id: string;
    slug: string;
  }>(
    `SELECT identity_id, slug
       FROM author
      WHERE identity_provider='weibo'
        AND identity_id=ANY($1::text[])`,
    [uniqueUserIds]
  )).rows;
  return new Map(rows.map((row) => [row.identity_id, row.slug]));
}
