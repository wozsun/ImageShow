import { appConfig } from "@imageshow/shared";
import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { GALLERY_FACETS_KEY } from "../images/image-cache.ts";

const THEME_VOCAB_KEY = "imageshow:theme_vocab";
const TAG_VOCAB_KEY = "imageshow:tag_vocab";
const AUTHOR_VOCAB_KEY = "imageshow:author_vocab";

export type VocabEntry = { slug: string; display_name: string };
export type AuthorVocabEntry = { slug: string; display_name: string; link: string };

async function loadVocab(table: "theme" | "tag"): Promise<VocabEntry[]> {
  return (await pool.query(`SELECT slug, display_name FROM ${table} ORDER BY slug`)).rows as VocabEntry[];
}

async function loadAuthorVocab(): Promise<AuthorVocabEntry[]> {
  return (await pool.query("SELECT slug, display_name, link FROM author ORDER BY slug")).rows as AuthorVocabEntry[];
}

async function cachedVocab<T>(key: string, load: () => Promise<T>): Promise<T> {
  try {
    const raw = await redis.get(key);
    if (raw) return JSON.parse(raw) as T;
    const rows = await load();
    await redis.set(key, JSON.stringify(rows), "EX", appConfig.derivedCacheTtlSeconds);
    return rows;
  } catch {
    return load();
  }
}

export function getThemeVocab(): Promise<VocabEntry[]> {
  return cachedVocab(THEME_VOCAB_KEY, () => loadVocab("theme"));
}

export function getTagVocab(): Promise<VocabEntry[]> {
  return cachedVocab(TAG_VOCAB_KEY, () => loadVocab("tag"));
}

export function getAuthorVocab(): Promise<AuthorVocabEntry[]> {
  return cachedVocab(AUTHOR_VOCAB_KEY, loadAuthorVocab);
}

async function invalidateVocab(vocabKey: string) {
  try {
    await redis.del(vocabKey, GALLERY_FACETS_KEY);
  } catch {
    // 旧词表会按 TTL 自然过期。
  }
}

export const invalidateThemeVocab = () => invalidateVocab(THEME_VOCAB_KEY);
export const invalidateTagVocab = () => invalidateVocab(TAG_VOCAB_KEY);
export const invalidateAuthorVocab = () => invalidateVocab(AUTHOR_VOCAB_KEY);
