import type { FacetOption } from "../types.js";

export function normalizeFacetInput(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export function facetSuggestions(
  options: readonly FacetOption[],
  query: string,
  excludedSlugs: ReadonlySet<string> = new Set()
) {
  if (!query) return [];
  return options
    .filter((option) => (
      !excludedSlugs.has(option.slug)
      && (
        option.slug.includes(query)
        || option.display_name.toLowerCase().includes(query)
      )
    ))
    .slice(0, 50);
}
