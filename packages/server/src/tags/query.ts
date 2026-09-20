import {
  getAdminTagList,
  getTagVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { resolveVocabularySlugs, resolveTermSlugMap } from "../vocab/terms.ts";
import type { TagDto } from "@imageshow/shared/browser";

export async function listTagsWithCounts(): Promise<TagDto[]> {
  return getAdminTagList();
}

export function resolveTagTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermSlugMap(() => getTagVocab(access), terms);
}

export function resolveTagNames(
  names: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  return resolveVocabularySlugs(() => getTagVocab(access), names);
}
