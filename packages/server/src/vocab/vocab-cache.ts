import { randomUUID } from "node:crypto";
import { appConfig } from "@imageshow/shared";
import { coalesce } from "../core/coalesce.ts";
import {
  publicPgFallbackWorkLimitExceeded,
  type PublicDatabaseReadAccess
} from "../core/database/public-fallback.ts";
import {
  pool,
  type DatabaseReader
} from "../core/database/pools.ts";
import {
  deleteRedisKeys,
  deleteRequiredRedisKeys,
  getRedisJson,
  getRequiredRedisJson,
  setRedisJson,
  setRequiredRedisJson
} from "../core/redis/json.ts";
import type {
  AuthorDto as Author,
  FacetOptionDto,
  IngestionVocabularyDto,
  TagDto as Tag,
  ThemeDto as Theme
} from "@imageshow/shared/browser";
import {
  projectAuthorDerivedIdentity,
  type AuthorIdentityColumns
} from "../authors/identity.ts";

const THEME_VOCAB_KEY = "imageshow:theme_vocab";
const TAG_VOCAB_KEY = "imageshow:tag_vocab";
const AUTHOR_VOCAB_KEY = "imageshow:author_vocab";
const ADMIN_THEME_LIST_KEY = "imageshow:admin:themes";
const ADMIN_TAG_LIST_KEY = "imageshow:admin:tags";
const ADMIN_AUTHOR_LIST_KEY = "imageshow:admin:authors";

export type EntityCacheKind = "theme" | "tag" | "author";
export type VocabEntry = FacetOptionDto;
export type AuthorVocabEntry = VocabEntry & { link: string };
export type VocabularyReadAccess = PublicDatabaseReadAccess & {
  redisMode?: "optional" | "required";
};

type EntityCountCacheInvalidationBatch = {
  add: (kinds: Iterable<EntityCacheKind>) => void;
  flush: () => Promise<void>;
  hasWork: () => boolean;
};
type EntityCacheEnvelope<T extends unknown[]> = {
  epoch: string;
  revision: number;
  value: T;
};
type EntityCacheReadOptions = {
  publicRead?: boolean;
  redisMode?: "optional" | "required";
};

// 单实例进程使用独立 epoch。Redis 删除失败或进程重启后，遗留值即使仍在
// 固定 key 下也不会绕过当前进程的 revision，下一次读取会单飞回源并覆盖。
const entityCacheEpoch = randomUUID();

const entityCountCacheRevisions: Record<EntityCacheKind, number> = {
  theme: 0,
  tag: 0,
  author: 0,
};
const entityVocabularyRevisions: Record<EntityCacheKind, number> = {
  theme: 0,
  tag: 0,
  author: 0,
};
const invalidatedEntityCountCaches = new Set<EntityCacheKind>();

function vocabFromRows(rows: Array<{ slug: string; display_name: string }>): VocabEntry[] {
  return rows.map(({ slug, display_name }) => ({ slug, display_name }));
}

async function queryVocabularyRows<T>(
  sql: string,
  reader: DatabaseReader = pool,
  bounded = false
) {
  const maximumRows = appConfig.publicPgFallback.maximumVocabularyRows;
  const rows = (await reader.query(
    `${sql}\n${bounded ? "LIMIT $1" : ""}`,
    bounded ? [maximumRows + 1] : undefined
  )).rows as T[];
  if (bounded && rows.length > maximumRows) {
    throw publicPgFallbackWorkLimitExceeded(
      "Vocabulary exceeds the supported public result limit"
    );
  }
  return rows;
}

async function readVocabularyRows<T>(
  sql: string,
  access: VocabularyReadAccess
) {
  return queryVocabularyRows<T>(
    sql,
    access.reader ?? pool,
    Boolean(access.reader)
  );
}

async function loadTagVocab(
  revision: number,
  access: VocabularyReadAccess = {}
) {
  const rows = await readVocabularyRows<VocabEntry>(
    `SELECT slug, display_name
       FROM tag
      ORDER BY sort_order ASC, slug ASC`,
    access
  );
  await cacheEntityVocabulary("tag", TAG_VOCAB_KEY, revision, rows, access);
  return rows;
}

async function loadThemeVocab(
  revision: number,
  access: VocabularyReadAccess = {}
) {
  const rows = await readVocabularyRows<VocabEntry>(
    `SELECT slug, display_name
       FROM theme
      ORDER BY (slug = 'none') DESC, sort_order ASC, slug ASC`,
    access
  );
  await cacheEntityVocabulary("theme", THEME_VOCAB_KEY, revision, rows, access);
  return rows;
}

async function loadAuthorVocab(
  revision: number,
  access: VocabularyReadAccess = {}
) {
  const rows = await readVocabularyRows<AuthorVocabEntry>(
    `SELECT slug, display_name, link
       FROM author
      ORDER BY sort_order ASC, slug ASC`,
    access
  );
  await cacheEntityVocabulary("author", AUTHOR_VOCAB_KEY, revision, rows, access);
  return rows;
}

async function loadAdminTagList(revision: number) {
  const rows = await queryVocabularyRows<Tag>(
    `SELECT t.slug, t.display_name, count(it.image_id)::int AS image_count
       FROM tag t
       LEFT JOIN image_tag it ON it.tag_slug = t.slug
      GROUP BY t.slug, t.display_name, t.sort_order
      ORDER BY t.sort_order ASC, t.slug ASC`
  );
  await cacheAdminEntityList("tag", ADMIN_TAG_LIST_KEY, revision, rows);
  return rows;
}

async function loadAdminThemeList(revision: number) {
  const rows = await queryVocabularyRows<Theme>(
    `SELECT t.slug, t.display_name, count(m.id)::int AS image_count
       FROM theme t
       LEFT JOIN metadata m ON m.theme = t.slug AND m.status = 'ready'
      GROUP BY t.slug, t.display_name, t.sort_order
      ORDER BY (t.slug = 'none') DESC, t.sort_order ASC, t.slug ASC`
  );
  await cacheAdminEntityList("theme", ADMIN_THEME_LIST_KEY, revision, rows);
  return rows;
}

async function loadAdminAuthorList(revision: number) {
  const rows = await queryVocabularyRows<AuthorIdentityColumns & Omit<
    Author,
    "derived_identity"
  >>(
    `SELECT a.slug,
            a.display_name,
            a.link,
            a.identity_provider,
            a.identity_id,
            count(m.id)::int AS image_count
       FROM author a
       LEFT JOIN metadata m ON m.author = a.slug AND m.status = 'ready'
      GROUP BY a.slug,
               a.display_name,
               a.link,
               a.identity_provider,
               a.identity_id,
               a.sort_order
      ORDER BY a.sort_order ASC, a.slug ASC`
  );
  const projected = rows.map((row): Author => {
    const { identity_provider, identity_id, ...item } = row;
    return {
      ...item,
      derived_identity: projectAuthorDerivedIdentity({
        identity_provider,
        identity_id
      })
    };
  });
  await cacheAdminEntityList(
    "author",
    ADMIN_AUTHOR_LIST_KEY,
    revision,
    projected
  );
  return projected;
}

async function cacheEntityVocabulary(
  kind: EntityCacheKind,
  key: string,
  revision: number,
  rows: unknown[],
  access: VocabularyReadAccess,
) {
  if (revision !== entityVocabularyRevisions[kind]) return;
  const required = access.redisMode === "required";
  const written = required
    ? await setRequiredRedisJson(key, entityCacheEnvelope(revision, rows))
    : await setRedisJson(key, entityCacheEnvelope(revision, rows));
  if (written && revision !== entityVocabularyRevisions[kind]) {
    if (required) await deleteRequiredRedisKeys(key);
    else await deleteRedisKeys(key);
  }
}

async function cacheAdminEntityList(
  kind: EntityCacheKind,
  key: string,
  revision: number,
  rows: unknown[],
) {
  if (revision !== entityCountCacheRevisions[kind]) return;
  const written = await setRedisJson(key, entityCacheEnvelope(revision, rows));
  if (!written) return;
  if (revision === entityCountCacheRevisions[kind]) {
    invalidatedEntityCountCaches.delete(kind);
    return;
  }

  // A mutation raced the Redis SET. Delete the stale value written after the
  // first invalidation so the next reader must take a fresh PostgreSQL snapshot.
  invalidatedEntityCountCaches.add(kind);
  await deleteRedisKeys(key);
}

function entityCacheEnvelope<T extends unknown[]>(revision: number, value: T): EntityCacheEnvelope<T> {
  return { epoch: entityCacheEpoch, revision, value };
}

async function cachedEntityValue<T extends unknown[]>(
  key: string,
  revision: number,
  coalesceKey: string,
  load: () => Promise<T>,
  options: EntityCacheReadOptions = {},
): Promise<T> {
  const requiredRedis = options.redisMode === "required";
  const cached = requiredRedis
    ? await getRequiredRedisJson<EntityCacheEnvelope<T>>(key)
    : await getRedisJson<EntityCacheEnvelope<T>>(key);
  if (
    cached?.epoch === entityCacheEpoch
    && cached.revision === revision
    && Array.isArray(cached.value)
  ) return cached.value;
  return options.publicRead
    ? load()
    : coalesce(`${coalesceKey}:${requiredRedis ? "required" : "optional"}`, load);
}

export function getThemeVocab(
  access: VocabularyReadAccess = {}
): Promise<VocabEntry[]> {
  const revision = entityVocabularyRevisions.theme;
  return cachedEntityValue(
    THEME_VOCAB_KEY,
    revision,
    `entity-cache:vocab:theme:${revision}`,
    () => loadThemeVocab(revision, access),
    {
      publicRead: Boolean(access.reader),
      redisMode: access.redisMode
    }
  );
}

export function getTagVocab(
  access: VocabularyReadAccess = {}
): Promise<VocabEntry[]> {
  const revision = entityVocabularyRevisions.tag;
  return cachedEntityValue(
    TAG_VOCAB_KEY,
    revision,
    `entity-cache:vocab:tag:${revision}`,
    () => loadTagVocab(revision, access),
    {
      publicRead: Boolean(access.reader),
      redisMode: access.redisMode
    }
  );
}

export function getAuthorVocab(
  access: VocabularyReadAccess = {}
): Promise<AuthorVocabEntry[]> {
  const revision = entityVocabularyRevisions.author;
  return cachedEntityValue(
    AUTHOR_VOCAB_KEY,
    revision,
    `entity-cache:vocab:author:${revision}`,
    () => loadAuthorVocab(revision, access),
    {
      publicRead: Boolean(access.reader),
      redisMode: access.redisMode
    }
  );
}

export function getAdminThemeList(): Promise<Theme[]> {
  const revision = entityCountCacheRevisions.theme;
  return cachedEntityValue(
    ADMIN_THEME_LIST_KEY,
    revision,
    `entity-cache:list:theme:${revision}`,
    () => loadAdminThemeList(revision),
  );
}

export function getAdminTagList(): Promise<Tag[]> {
  const revision = entityCountCacheRevisions.tag;
  return cachedEntityValue(
    ADMIN_TAG_LIST_KEY,
    revision,
    `entity-cache:list:tag:${revision}`,
    () => loadAdminTagList(revision),
  );
}

export function getAdminAuthorList(): Promise<Author[]> {
  const revision = entityCountCacheRevisions.author;
  return cachedEntityValue(
    ADMIN_AUTHOR_LIST_KEY,
    revision,
    `entity-cache:list:author:${revision}`,
    () => loadAdminAuthorList(revision),
  );
}

export async function getIngestionVocabulary(): Promise<IngestionVocabularyDto> {
  const [themes, tags, authors] = await Promise.all([
    getThemeVocab(),
    getTagVocab(),
    getAuthorVocab(),
  ]);
  return { themes, tags, authors: vocabFromRows(authors) };
}

const vocabularyLoaders: Record<EntityCacheKind, {
  key: string;
  load: (revision: number) => Promise<unknown>;
}> = {
  theme: { key: THEME_VOCAB_KEY, load: loadThemeVocab },
  tag: { key: TAG_VOCAB_KEY, load: loadTagVocab },
  author: { key: AUTHOR_VOCAB_KEY, load: loadAuthorVocab },
};

const entityCountCacheKeys: Record<EntityCacheKind, string> = {
  theme: ADMIN_THEME_LIST_KEY,
  tag: ADMIN_TAG_LIST_KEY,
  author: ADMIN_AUTHOR_LIST_KEY,
};

function uniqueEntityKinds(kinds: Iterable<EntityCacheKind>) {
  return [...new Set(kinds)];
}

export async function refreshEntityVocabularies(kinds: Iterable<EntityCacheKind>) {
  await Promise.all(uniqueEntityKinds(kinds).map(async (kind) => {
    const loader = vocabularyLoaders[kind];
    const revision = entityVocabularyRevisions[kind] + 1;
    entityVocabularyRevisions[kind] = revision;
    await deleteRedisKeys(loader.key);
    await coalesce(`entity-cache:vocab:${kind}:${revision}`, () => loader.load(revision)).catch(async () => {
      await deleteRedisKeys(loader.key);
    });
  }));
}

export async function invalidateEntityCountCaches(kinds: Iterable<EntityCacheKind>) {
  const pending: EntityCacheKind[] = [];
  for (const kind of uniqueEntityKinds(kinds)) {
    entityCountCacheRevisions[kind] += 1;
    if (invalidatedEntityCountCaches.has(kind)) continue;
    invalidatedEntityCountCaches.add(kind);
    pending.push(kind);
  }
  if (!pending.length) return;
  const deleted = await deleteRedisKeys(...pending.map((kind) => entityCountCacheKeys[kind]));
  if (!deleted) {
    for (const kind of pending) invalidatedEntityCountCaches.delete(kind);
  }
}

/**
 * Collects entity-list invalidations across a multi-image mutation.
 * Single-image callers omit the batch and keep immediate invalidation behavior.
 */
export function createEntityCountCacheInvalidationBatch(): EntityCountCacheInvalidationBatch {
  const pending = new Set<EntityCacheKind>();
  return {
    add(kinds) {
      for (const kind of kinds) pending.add(kind);
    },
    async flush() {
      if (!pending.size) return;
      const kinds = [...pending];
      pending.clear();
      await invalidateEntityCountCaches(kinds);
    },
    hasWork() {
      return pending.size > 0;
    },
  };
}

export async function invalidateOrCollectEntityCountCaches(
  kinds: Iterable<EntityCacheKind>,
  batch?: EntityCountCacheInvalidationBatch,
) {
  if (batch) {
    batch.add(kinds);
    return;
  }
  await invalidateEntityCountCaches(kinds);
}

export type { EntityCountCacheInvalidationBatch };
