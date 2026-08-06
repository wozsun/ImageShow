/**
 * 浏览器与服务端共同使用、且可以安全进入公开前端产物的基础常量。
 *
 * 后端运行时默认配置只存在于 app-config.ts；这里不得引入 Node、数据库、
 * Redis、存储凭据或完整服务端默认值。
 */
export const imageTitleMaxLength = 80;
export const imageDescriptionMaxLength = 500;
export const importBatchHardLimit = 3_600;
export const configPackageMaxBytes = 1024 * 1024;
export const configPackageRequestMaxBytes =
  configPackageMaxBytes + 64 * 1024;
export const adminImagePageLimit = 60;
export const altchaSolveTimeoutMs = 60_000;

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const slugMaxLength = 32;

export const adminBasePath = "/admin";
export const adminApiBasePath = "/api/admin";

export const devices = ["pc", "mb"] as const;
export const brightnesses = ["dark", "light"] as const;

export type Device = (typeof devices)[number];
export type Brightness = (typeof brightnesses)[number];
export type StorageType = "local" | "s3" | "webdav";

export type AdminRole = "super" | "image";
export const logLevels = ["DEBUG", "INFO", "WARN", "ERROR", "OFF"] as const;
export type LogLevel = (typeof logLevels)[number];
export const adminPermissions = {
  imageStorageMigrate: "image.storage.migrate",
  imageTrashPurge: "image.trash.purge",
  imageTrashEmpty: "image.trash.empty",
  tagDelete: "tag.delete",
  themeDelete: "theme.delete",
  authorDelete: "author.delete",
  storageMaintenanceMigrate: "storage.maintenance.migrate",
  storageMaintenanceCleanup: "storage.maintenance.cleanup",
  cacheMaintenanceRebuild: "cache.maintenance.rebuild"
} as const;
export type AdminPermission =
  (typeof adminPermissions)[keyof typeof adminPermissions];

// 管理端界面偏好以 PostgreSQL 为权威，并由浏览器本地存储提供首帧与离线兜底。
// 将键和值域集中在 shared；新增偏好时，类型、服务端校验和前端投影会同步暴露缺口。
export const imageCardDensities = ["compact", "spacious"] as const;
export const adminColorSchemes = ["light", "dark", "system"] as const;
export const adminPreferenceValueOptions = {
  color_scheme: adminColorSchemes,
  image_card_density: imageCardDensities
} as const;
export const adminPreferencesMaxBytes = 4 * 1024;

export type AdminColorScheme = (typeof adminColorSchemes)[number];
export type ImageCardDensity = (typeof imageCardDensities)[number];
export type AdminPreferenceKey = keyof typeof adminPreferenceValueOptions;
export const adminPreferenceKeys = Object.freeze(
  Object.keys(adminPreferenceValueOptions) as AdminPreferenceKey[]
);

export type AdminPreferenceValues = {
  [Key in AdminPreferenceKey]: (typeof adminPreferenceValueOptions)[Key][number];
};

export const defaultAdminPreferences: Readonly<AdminPreferenceValues> =
  Object.freeze({
    color_scheme: "system",
    image_card_density: "compact"
  });

export type AdminPreferences = Partial<AdminPreferenceValues>;

export type SiteVersionSettings = {
  enabled: boolean;
  link_enabled: boolean;
};

export function normalizeAdminPreferences(value: unknown): AdminPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const preferences: Record<string, string> = {};
  for (const key of adminPreferenceKeys) {
    const candidate = input[key];
    const options = adminPreferenceValueOptions[key] as readonly string[];
    if (typeof candidate === "string" && options.includes(candidate)) {
      preferences[key] = candidate;
    }
  }
  return preferences as AdminPreferences;
}

export type ApiErrorResponse = {
  ok: false;
  code: string;
  error: string;
  details?: unknown;
};

export type ApiSuccessResponse<T extends Record<string, unknown>> = {
  ok: true;
} & T;

export type AuthStateDto = {
  authenticated: false;
  altcha_enabled: boolean;
  login_background: string;
} | {
  authenticated: true;
  username: string;
  role: AdminRole;
  permissions: AdminPermission[];
  csrf_token: string;
  application_version: string;
  preferences: AdminPreferences;
  version_settings: SiteVersionSettings;
};

export type AdminLoginResultDto = {
  csrf_token: string;
};

export type AdminPreferencesResponseDto = {
  preferences: AdminPreferences;
};
