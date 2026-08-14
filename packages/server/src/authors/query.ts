import {
  getAdminAuthorList,
  getAuthorVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { AuthorDto } from "@imageshow/shared/browser";

export function resolveAuthorTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermMap(() => getAuthorVocab(access), terms);
}

export function resolveAuthorSlugs(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  return resolveSlugs(() => getAuthorVocab(access), terms);
}

export async function listAuthorsWithMeta(): Promise<AuthorDto[]> {
  return getAdminAuthorList();
}
