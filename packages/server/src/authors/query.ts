import { getAdminAuthorList, getAuthorVocab } from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { Author } from "./types.ts";

export function resolveAuthorTermMap(terms: string[]): Promise<Map<string, string>> {
  return resolveTermMap(getAuthorVocab, terms);
}

export function resolveAuthorSlugs(terms: string[]): Promise<string[]> {
  return resolveSlugs(getAuthorVocab, terms);
}

export async function listAuthorsWithMeta(): Promise<Author[]> {
  return getAdminAuthorList();
}
