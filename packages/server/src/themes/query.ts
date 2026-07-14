import { getAdminThemeList, getThemeVocab } from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { Theme } from "./types.ts";

export function resolveThemeTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getThemeVocab, terms);
}

export function resolveThemeSlugs(terms: string[]): Promise<string[]> {
  return resolveSlugs(getThemeVocab, terms);
}

export async function listThemesWithMeta(): Promise<Theme[]> {
  return getAdminThemeList();
}
