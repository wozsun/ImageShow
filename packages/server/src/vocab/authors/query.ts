import {
  getAuthorVocab,
  type VocabularyReadAccess
} from "../cache.ts";
import { pool } from "../../core/database/pools.ts";
import { isWeiboUserId } from "./identity.ts";

export async function getAuthorSlugs(
  access: VocabularyReadAccess = {}
) {
  return new Set((await getAuthorVocab(access)).map((entry) => entry.slug));
}

export async function resolveWeiboAuthorSlugs(
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  const uniqueUserIds = [...new Set(userIds)].filter(isWeiboUserId);
  if (!uniqueUserIds.length) return new Map();
  const rows = (
    await pool.query<{
      identity_id: string;
      slug: string;
    }>(
      `SELECT identity_id, slug
       FROM author
      WHERE identity_provider='weibo'
        AND identity_id=ANY($1::text[])`,
      [uniqueUserIds]
    )
  ).rows;
  return new Map(rows.map((row) => [row.identity_id, row.slug]));
}
