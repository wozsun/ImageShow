// Shared term → canonical-slug resolution for the theme / tag / author vocabularies.
// All three resolve a free-text search term (a display name / alias, or a slug) the
// same way: display-name matches are applied first and slug-identity last, so an exact
// slug always wins over a display-name collision. Built from a (cached) vocabulary list;
// a term with no match is absent from the map, and callers treat those as already-a-slug.
type VocabRow = { slug: string; display_name: string };

// Maps each given search term (lowercased) to a canonical slug via the vocabulary's
// display name or the slug itself. `loadVocab` supplies the (cached) theme / tag /
// author rows.
export async function resolveTermMap(loadVocab: () => Promise<VocabRow[]>, terms: string[]): Promise<Map<string, string>> {
  const wanted = new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean));
  const map = new Map<string, string>();
  if (!wanted.size) return map;
  const vocab = await loadVocab();
  for (const { slug, display_name } of vocab) {
    const name = display_name.trim().toLowerCase();
    if (name && wanted.has(name)) map.set(name, slug);
  }
  for (const { slug } of vocab) {
    if (wanted.has(slug)) map.set(slug, slug);
  }
  return map;
}

// Resolves terms to a deduped list of canonical slugs; an unmatched term passes through
// as-is (lowercased) so a direct slug search still works.
export async function resolveSlugs(loadVocab: () => Promise<VocabRow[]>, terms: string[]): Promise<string[]> {
  const map = await resolveTermMap(loadVocab, terms);
  const normalized = terms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  return [...new Set(normalized.map((term) => map.get(term) ?? term))];
}
