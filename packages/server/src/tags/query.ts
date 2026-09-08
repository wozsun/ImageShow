import {
  getAdminTagList,
  getTagVocab,
  type VocabularyReadAccess
} from "../vocab/vocab-cache.ts";
import { resolveSlugs, resolveTermMap } from "../core/term-resolve.ts";
import type { TagDto } from "@imageshow/shared/browser";

export async function listTagsWithCounts(): Promise<TagDto[]> {
  return getAdminTagList();
}

export function resolveTagTermMap(
  terms: string[],
  access: VocabularyReadAccess = {}
): Promise<Map<string, string>> {
  return resolveTermMap(() => getTagVocab(access), terms);
}

export function resolveTagNames(
  names: string[],
  access: VocabularyReadAccess = {}
): Promise<string[]> {
  return resolveSlugs(() => getTagVocab(access), names);
}
