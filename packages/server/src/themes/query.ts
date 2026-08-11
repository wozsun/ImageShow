import { getAdminThemeList, getThemeVocab } from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { ThemeDto } from "@imageshow/shared/browser";
import type {
  PublicDatabaseReadAccess
} from "../core/public-db-fallback.ts";

export function resolveThemeTermMap(
  terms: string[],
  access: PublicDatabaseReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermMap(() => getThemeVocab(access), terms);
}

export function resolveThemeSlugs(
  terms: string[],
  access: PublicDatabaseReadAccess = {}
): Promise<string[]> {
  return resolveSlugs(() => getThemeVocab(access), terms);
}

export async function listThemesWithMeta(): Promise<ThemeDto[]> {
  return getAdminThemeList();
}
