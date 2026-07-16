/**
 * 浏览器与服务端都会使用、且可以安全进入前端产物的常量。
 *
 * 后端运行时默认配置保留在 app-config.ts。前端必须从
 * `@imageshow/shared/browser` 导入运行时值，避免仅使用几个校验常量时
 * 将数据库、Redis 等服务端默认值一并打入浏览器脚本。
 */
export const imageTitleMaxLength = 80;
export const imageDescriptionMaxLength = 500;
export const importBatchHardLimit = 3_600;
export const adminImagePageLimit = 60;

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const adminBasePath = "/admin";
export const adminApiBasePath = "/api/admin";

export const reservedSubdomains = ["random", "static", "docs", "link"] as const;

// 管理端界面偏好由 Redis 跨设备同步，并由浏览器本地存储兜底。
// 将键和值域集中在 shared，避免前端、接口校验和 Redis 解析各自维护字符串字面量。
export const imageCardDensities = ["compact", "comfortable"] as const;
export const adminPreferenceKeys = ["image_card_density"] as const;

export type ImageCardDensity = (typeof imageCardDensities)[number];
export type AdminPreferenceKey = (typeof adminPreferenceKeys)[number];

export type AdminPreferenceValues = {
  image_card_density: ImageCardDensity;
};

export type AdminPreferences = Partial<AdminPreferenceValues>;
