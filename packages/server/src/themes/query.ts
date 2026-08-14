import {
  getAdminThemeList,
  getThemeVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { ThemeDto } from "@imageshow/shared/browser";

export function resolveThemeTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermMap(() => getThemeVocab(access), terms);
}

export function resolveThemeSlugs(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  return resolveSlugs(() => getThemeVocab(access), terms);
}

export async function listThemesWithMeta(): Promise<ThemeDto[]> {
  return getAdminThemeList();
}
