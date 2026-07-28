import type { SiteSettings } from "./types.js";
export {
  adminApiBasePath,
  adminBasePath,
  adminImagePageLimit,
  slugPattern
} from "@imageshow/shared/browser";

export const slugFormatHint = "只能包含小写字母、数字、连字符";

export const galleryLoadBufferScreens = 1;
export const galleryResidenceBufferScreens = 2;
export const galleryVirtualOverscanScreens = 2.5;
export const galleryMaxMountedTiles = 160;
export const gallerySentinelRootMargin = "280px 0px";

export function publicRootPath(
  site: Pick<SiteSettings, "root_redirect" | "home">
): "/home" | "/gallery" {
  return site.home.enabled === false || site.root_redirect === "gallery" ? "/gallery" : "/home";
}
