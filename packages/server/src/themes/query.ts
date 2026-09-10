import { unsetThemeFilter } from "@imageshow/shared/browser";
import {
  getAdminThemeList,
  getThemeVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { resolveTermMap } from "../core/term-resolve.ts";
import type { ThemeDto } from "@imageshow/shared/browser";

export async function resolveThemeTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  const map = await resolveTermMap(() => getThemeVocab(access), terms);
  // 6.2.0 transition for bookmarked/public random URLs.
  if (terms.some((term) => term.trim().toLowerCase() === "none")) map.set("none", unsetThemeFilter);
  return map;
}

export async function resolveThemeSlugs(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  const map = await resolveThemeTermMap(terms, access);
  return [...new Set(terms.map((term) => {
    const value = term.trim().toLowerCase();
    return map.get(value) ?? value;
  }).filter(Boolean))];
}

export async function listThemesWithMeta(): Promise<ThemeDto[]> {
  return getAdminThemeList();
}
