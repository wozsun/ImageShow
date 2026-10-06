import { adminBasePath } from "@imageshow/shared/browser";

export {
  adminApiBasePath,
  adminBasePath,
  publicHomeBrowsePath,
  publicRootPath,
  slugPattern
} from "@imageshow/shared/browser";

// 后台入口 adminBasePath 直接显示概览、地址保持不变；导航中的“概览”使用显式地址。
export const adminOverviewPath = `${adminBasePath}/overview`;

export const slugFormatHint = "只能包含小写字母、数字、连字符";

export const galleryLoadBufferScreens = 1;
export const galleryResidenceBufferScreens = 2;
export const galleryVirtualOverscanScreens = 3;
export const galleryMaxMountedTiles = 180;
export const galleryDataWindowFullItemBudget = 480;
export const galleryDataWindowMaxConcurrentPageLoads = 2;
