import type { SiteSettings } from "./types.js";
export {
  adminApiBasePath,
  adminBasePath,
  adminImagePageLimit,
  reservedSubdomains,
  slugPattern
} from "@imageshow/shared/browser";

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
  me: ["me"] as const
};

export const slugFormatHint = "只能包含小写字母、数字、连字符";

export const galleryRenderBatch = 12;

export const eagerThumbnailCount = 12;

export const galleryLazyRootMargin = "360px 0px";
export const gallerySentinelRootMargin = "280px 0px";

export function publicRootPath(
  site: Pick<SiteSettings, "root_redirect" | "home">
): "/home" | "/gallery" {
  return site.home.enabled === false || site.root_redirect === "gallery" ? "/gallery" : "/home";
}
