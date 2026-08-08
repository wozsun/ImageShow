import {
  slugMaxLength,
  slugPattern
} from "@imageshow/shared/browser";
import type { FacetOption } from "../types.js";

export function normalizeFacetSearchQuery(value: string) {
  return value.trim().toLowerCase();
}

export function parseFacetSlug(value: string) {
  const slug = value.trim().toLowerCase();
  return slug.length <= slugMaxLength && slugPattern.test(slug)
    ? slug
    : null;
}

export function facetSuggestions(
  options: readonly FacetOption[],
  query: string,
  excludedSlugs: ReadonlySet<string> = new Set()
) {
  const normalizedQuery = normalizeFacetSearchQuery(query);
  if (!normalizedQuery) return [];
  return options
    .filter((option) => (
      !excludedSlugs.has(option.slug)
      && (
        option.slug.includes(normalizedQuery)
        || option.display_name.toLowerCase().includes(normalizedQuery)
      )
    ))
    .slice(0, 50);
}
