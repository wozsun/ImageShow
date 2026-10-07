import {
  getTagVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { resolveVocabularySlugs, resolveTermSlugMap } from "../vocab/terms.ts";

export function resolveTagTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermSlugMap(() => getTagVocab(access), terms);
}

export function resolveTagSlugs(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  return resolveVocabularySlugs(() => getTagVocab(access), terms);
}
