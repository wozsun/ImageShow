import {
  getTagVocab,
  type VocabularyReadAccess
} from "../cache.ts";
export async function getTagSlugs(
  access: VocabularyReadAccess = {}
) {
  return new Set((await getTagVocab(access)).map((entry) => entry.slug));
}
