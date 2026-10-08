import { randomUUID } from "node:crypto";
import { appConfig } from "@imageshow/shared";
import type { PublicDatabaseReadAccess } from "../../core/database/public-fallback.ts";
import { publicPgFallbackWorkLimitExceeded } from "../../core/database/public-fallback.ts";
import { deleteRedisKeys, getRedisJson, setRedisJson } from "../../core/redis/json.ts";

const key = "imageshow:group_slugs";
const epoch = randomUUID();
let revision = 0;
type CachedSlugs = { epoch: string; revision: number; slugs: string[] };

/** Same process epoch rule as vocabulary caches: failed deletion cannot revive old data. */
export async function withGroupSlugCacheInvalidation<T>(work: () => Promise<T>) {
  try {
    return await work();
  } finally {
    revision += 1;
    await deleteRedisKeys(key);
  }
}

export async function readImageGroupSlugs(access: PublicDatabaseReadAccess): Promise<ReadonlySet<string>> {
  const currentRevision = revision;
  const cached = await getRedisJson<CachedSlugs>(key);
  if (cached?.epoch === epoch && cached.revision === currentRevision && Array.isArray(cached.slugs)) {
    return new Set(cached.slugs);
  }
  // Use the request's admission-bound reader; never coalesce across reader lifetimes.
  const maximum = appConfig.publicPgFallback.maximumVocabularyRows;
  const rows = (await access.reader.query<{ slug: string }>(
    "SELECT slug FROM image_group ORDER BY slug LIMIT $1", [maximum + 1]
  )).rows;
  if (rows.length > maximum) {
    throw publicPgFallbackWorkLimitExceeded("Group slugs exceed the supported public result limit");
  }
  const slugs = rows.map((row) => row.slug);
  if (revision === currentRevision) {
    await setRedisJson(key, { epoch, revision: currentRevision, slugs });
  }
  return new Set(slugs);
}
