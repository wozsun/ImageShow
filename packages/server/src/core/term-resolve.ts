type VocabRow = { slug: string; display_name: string };

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

export async function resolveSlugs(loadVocab: () => Promise<VocabRow[]>, terms: string[]): Promise<string[]> {
  const map = await resolveTermMap(loadVocab, terms);
  const normalized = terms.map((term) => term.trim().toLowerCase()).filter(Boolean);
  return [...new Set(normalized.map((term) => map.get(term) ?? term))];
}
