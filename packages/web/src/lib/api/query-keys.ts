/** Query-key prefixes are the single cache-identity contract for the SPA. */
export const queryKeys = {
  siteConfig: ["site-config"] as const,
  galleryFacets: ["gallery-facets"] as const,
  publicImages: ["public-images"] as const,
  publicImageDetail: ["public-image-detail"] as const,
  adminImageInfo: ["admin-image-info"] as const,
  overview: ["admin-overview"] as const,
  adminImages: ["admin-images"] as const,
  tags: ["tags"] as const,
  themes: ["themes"] as const,
  authors: ["authors"] as const,
  importVocabulary: ["import-vocabulary"] as const,
  users: ["users"] as const,
  settings: ["settings"] as const,
  adminPreferences: ["admin-preferences"] as const,
  logs: ["admin-logs"] as const,
  storageBackends: ["storage-backends"] as const,
  storageOptions: ["storage-options"] as const,
  me: ["me"] as const
};
