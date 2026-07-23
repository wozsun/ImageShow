import { randomUUID } from "node:crypto";
import { coalesce } from "../core/coalesce.ts";
import { pool } from "../core/db.ts";
import { deleteRedisKeys, getRedisJson, setRedisJson } from "../core/redis-json.ts";
import type { Author } from "../authors/types.ts";
import type { Tag } from "../tags/types.ts";
import type { Theme } from "../themes/types.ts";

const THEME_VOCAB_KEY = "imageshow:theme_vocab";
const TAG_VOCAB_KEY = "imageshow:tag_vocab";
const AUTHOR_VOCAB_KEY = "imageshow:author_vocab";
const ADMIN_THEME_LIST_KEY = "imageshow:admin:themes";
const ADMIN_TAG_LIST_KEY = "imageshow:admin:tags";
const ADMIN_AUTHOR_LIST_KEY = "imageshow:admin:authors";

export type EntityCacheKind = "theme" | "tag" | "author";
export type VocabEntry = { slug: string; display_name: string };
export type AuthorVocabEntry = VocabEntry & { link: string };
export type ImportVocabulary = {
  themes: VocabEntry[];
  tags: VocabEntry[];
  authors: VocabEntry[];
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

async function loadTagVocab(revision: number) {
  const rows = (await pool.query(
    `SELECT slug, display_name
       FROM tag
      ORDER BY sort_order ASC, slug ASC`,
  )).rows as VocabEntry[];
  await cacheEntityVocabulary("tag", TAG_VOCAB_KEY, revision, rows);
  return rows;
}

async function loadThemeVocab(revision: number) {
  const rows = (await pool.query(
    `SELECT slug, display_name
       FROM theme
      ORDER BY (slug = 'none') DESC, sort_order ASC, slug ASC`,
  )).rows as VocabEntry[];
  await cacheEntityVocabulary("theme", THEME_VOCAB_KEY, revision, rows);
  return rows;
}

async function loadAuthorVocab(revision: number) {
  const rows = (await pool.query(
    `SELECT slug, display_name, link
       FROM author
      ORDER BY sort_order ASC, slug ASC`,
  )).rows as AuthorVocabEntry[];
  await cacheEntityVocabulary("author", AUTHOR_VOCAB_KEY, revision, rows);
  return rows;
}

async function loadAdminTagList(revision: number) {
  const rows = (await pool.query(
    `SELECT t.slug, t.display_name, count(it.image_id)::int AS image_count
       FROM tag t
       LEFT JOIN image_tag it ON it.tag_slug = t.slug
      GROUP BY t.slug, t.display_name, t.sort_order
      ORDER BY t.sort_order ASC, t.slug ASC`,
  )).rows as Tag[];
  await cacheAdminEntityList("tag", ADMIN_TAG_LIST_KEY, revision, rows);
  return rows;
}

async function loadAdminThemeList(revision: number) {
  const rows = (await pool.query(
    `SELECT t.slug, t.display_name, count(m.id)::int AS image_count
       FROM theme t
       LEFT JOIN metadata m ON m.theme = t.slug AND m.status = 'ready'
      GROUP BY t.slug, t.display_name, t.sort_order
      ORDER BY (t.slug = 'none') DESC, t.sort_order ASC, t.slug ASC`,
  )).rows as Theme[];
  await cacheAdminEntityList("theme", ADMIN_THEME_LIST_KEY, revision, rows);
  return rows;
}

async function loadAdminAuthorList(revision: number) {
  const rows = (await pool.query(
    `SELECT a.slug, a.display_name, a.link, count(m.id)::int AS image_count
       FROM author a
       LEFT JOIN metadata m ON m.author = a.slug AND m.status = 'ready'
      GROUP BY a.slug, a.display_name, a.link, a.sort_order
      ORDER BY a.sort_order ASC, a.slug ASC`,
  )).rows as Author[];
  await cacheAdminEntityList("author", ADMIN_AUTHOR_LIST_KEY, revision, rows);
  return rows;
}

async function cacheEntityVocabulary(
  kind: EntityCacheKind,
  key: string,
  revision: number,
  rows: unknown[],
) {
  if (revision !== entityVocabularyRevisions[kind]) return;
  const written = await setRedisJson(key, entityCacheEnvelope(revision, rows));
  if (written && revision !== entityVocabularyRevisions[kind]) {
    await deleteRedisKeys(key);
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
): Promise<T> {
  const cached = await getRedisJson<EntityCacheEnvelope<T>>(key);
  if (
    cached?.epoch === entityCacheEpoch
    && cached.revision === revision
    && Array.isArray(cached.value)
  ) return cached.value;
  return coalesce(coalesceKey, load);
}

export function getThemeVocab(): Promise<VocabEntry[]> {
  const revision = entityVocabularyRevisions.theme;
  return cachedEntityValue(
    THEME_VOCAB_KEY,
    revision,
    `entity-cache:vocab:theme:${revision}`,
    () => loadThemeVocab(revision),
  );
}

export function getTagVocab(): Promise<VocabEntry[]> {
  const revision = entityVocabularyRevisions.tag;
  return cachedEntityValue(
    TAG_VOCAB_KEY,
    revision,
    `entity-cache:vocab:tag:${revision}`,
    () => loadTagVocab(revision),
  );
}

export function getAuthorVocab(): Promise<AuthorVocabEntry[]> {
  const revision = entityVocabularyRevisions.author;
  return cachedEntityValue(
    AUTHOR_VOCAB_KEY,
    revision,
    `entity-cache:vocab:author:${revision}`,
    () => loadAuthorVocab(revision),
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

export async function getImportVocabulary(): Promise<ImportVocabulary> {
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
