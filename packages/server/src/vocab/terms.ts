type VocabularyTermRow = { slug: string; display_name: string };

export async function resolveTermSlugMap(loadVocabulary: () => Promise<VocabularyTermRow[]>, terms: string[]): Promise<Map<string, string>> {
  const requestedTerms = new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean));
  const slugsByTerm = new Map<string, string>();
  if (!requestedTerms.size) return slugsByTerm;
  const vocabulary = await loadVocabulary();
  for (const { slug, display_name } of vocabulary) {
    const name = display_name.trim().toLowerCase();
    if (name && requestedTerms.has(name)) slugsByTerm.set(name, slug);
  }
  for (const { slug } of vocabulary) {
    if (requestedTerms.has(slug)) slugsByTerm.set(slug, slug);
  }
  return slugsByTerm;
}

export async function resolveVocabularySlugs(loadVocabulary: () => Promise<VocabularyTermRow[]>, terms: string[]): Promise<string[]> {
  const slugsByTerm = await resolveTermSlugMap(loadVocabulary, terms);
  const normalizedTerms = terms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  return [...new Set(normalizedTerms.map((term) => slugsByTerm.get(term) ?? term))];
}
