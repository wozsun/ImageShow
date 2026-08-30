import type { SiteSettings } from "./types.js";
export {
  adminApiBasePath,
  adminBasePath,
  adminImagePageLimit,
  slugMaxLength,
  slugPattern
} from "@imageshow/shared/browser";

export const slugFormatHint = "只能包含小写字母、数字、连字符";

export const galleryLoadBufferScreens = 1;
export const galleryResidenceBufferScreens = 2;
export const galleryVirtualOverscanScreens = 3;
export const galleryMaxMountedTiles = 180;
export const galleryDataWindowFullItemBudget = 480;
export const galleryDataWindowMaxConcurrentPageLoads = 2;

export function publicRootPath(
  site: Pick<SiteSettings, "root" | "home">
): "/home" | "/gallery" {
  return site.home.enabled === false || site.root === "gallery" ? "/gallery" : "/home";
}
