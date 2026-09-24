import { slugMaxLength, slugPattern } from "@imageshow/shared/browser";
import type { FacetOption } from "../types.js";

export type FacetTextMatch = {
  rank: number;
  ranges: [number, number][];
};

export type FacetSuggestion = FacetOption & {
  slugMatch: FacetTextMatch | null;
  displayNameMatch: FacetTextMatch | null;
};

export function normalizeFacetSearchQuery(value: string) {
  return value.trim().toLowerCase();
}

export function parseFacetSlug(value: string) {
  const slug = value.trim().toLowerCase();
  return slug.length <= slugMaxLength && slugPattern.test(slug) ? slug : null;
}

export function matchFacetText(value: string, query: string): FacetTextMatch | null {
  const normalizedValue = value.toLowerCase();
  const start = normalizedValue.indexOf(query);
  if (start >= 0) {
    return {
      rank: normalizedValue === query ? 0 : 1,
      ranges: [[start, start + query.length]]
    };
  }

  const ranges: [number, number][] = [];
  let offset = 0;
  for (const character of query) {
    const index = normalizedValue.indexOf(character, offset);
    if (index < 0) return null;
    offset = index + character.length;
    const previous = ranges.at(-1);
    if (previous?.[1] === index) previous[1] = offset;
    else ranges.push([index, offset]);
  }
  return { rank: 2, ranges };
}

export function facetSuggestions(
  options: readonly FacetOption[],
  query: string,
  excludedSlugs: ReadonlySet<string> = new Set(),
  matchName: typeof matchFacetText = matchFacetText,
  limit = 50
) {
  const normalizedQuery = normalizeFacetSearchQuery(query);
  if (!normalizedQuery) return [];

  // Literal tiers precede phonetic matches; vocabulary order is stable within each tier.
  const matches: FacetSuggestion[][] = [[], [], [], []];
  for (const option of options) {
    if (excludedSlugs.has(option.slug)) continue;
    const slugMatch = matchFacetText(option.slug, normalizedQuery);
    const displayNameMatch = matchName(option.display_name, normalizedQuery);
    const rank = Math.min(slugMatch?.rank ?? Infinity, displayNameMatch?.rank ?? Infinity);
    const tier = matches[rank];
    if (tier && tier.length < limit) tier.push({ ...option, slugMatch, displayNameMatch });
  }
  return matches.flat().slice(0, limit);
}
