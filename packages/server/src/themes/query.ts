import {
  getAdminThemeList,
  getThemeVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { resolveVocabularySlugs, resolveTermSlugMap } from "../vocab/terms.ts";
import type { ThemeDto } from "@imageshow/shared/browser";

export async function resolveThemeTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermSlugMap(() => getThemeVocab(access), terms);
}

export async function resolveThemeSlugs(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  return resolveVocabularySlugs(() => getThemeVocab(access), terms);
}

export async function listThemesWithMeta(): Promise<ThemeDto[]> {
  return getAdminThemeList();
}
