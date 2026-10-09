import {
  getThemeVocab,
  type VocabularyReadAccess
} from "../cache.ts";
export async function getThemeSlugs(
  access: VocabularyReadAccess = {}
) {
  return new Set((await getThemeVocab(access)).map((entry) => entry.slug));
}
