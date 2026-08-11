import { getAdminAuthorList, getAuthorVocab } from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { AuthorDto } from "@imageshow/shared/browser";
import type {
  PublicDatabaseReadAccess
} from "../core/public-db-fallback.ts";

export function resolveAuthorTermMap(
  terms: string[],
  access: PublicDatabaseReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermMap(() => getAuthorVocab(access), terms);
}

export function resolveAuthorSlugs(
  terms: string[],
  access: PublicDatabaseReadAccess = {}
): Promise<string[]> {
  return resolveSlugs(() => getAuthorVocab(access), terms);
}

export async function listAuthorsWithMeta(): Promise<AuthorDto[]> {
  return getAdminAuthorList();
}
