import type { SiteSettings } from "./types.js";
export {
  adminApiBasePath,
  adminBasePath,
  adminImagePageLimit,
  reservedSubdomains,
  slugPattern
} from "@imageshow/shared/browser";

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
