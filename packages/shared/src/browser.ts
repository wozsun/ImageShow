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
export const altchaSolveTimeoutMs = 60_000;

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const adminBasePath = "/admin";
export const adminApiBasePath = "/api/admin";

export const reservedSubdomains = ["random", "static", "docs", "link"] as const;
export const devices = ["pc", "mb"] as const;
export const brightnesses = ["dark", "light"] as const;

export type Device = (typeof devices)[number];
export type Brightness = (typeof brightnesses)[number];
export type StorageType = "local" | "s3" | "webdav";
export type AdminRole = "super" | "image";

// 管理端界面偏好由 Redis 跨设备同步，并由浏览器本地存储兜底。
// 将键和值域集中在 shared，避免前端、接口校验和 Redis 解析各自维护字符串字面量。
export const imageCardDensities = ["compact", "spacious"] as const;
export const adminPreferenceKeys = ["image_card_density"] as const;

export type ImageCardDensity = (typeof imageCardDensities)[number];
export type AdminPreferenceKey = (typeof adminPreferenceKeys)[number];

export type AdminPreferenceValues = {
  image_card_density: ImageCardDensity;
};

export type AdminPreferences = Partial<AdminPreferenceValues>;

/** Stable admin image mutation contracts shared by the HTTP service and SPA. */
export type BatchImageUpdateItemResult =
  | { id: string; status: "updated" }
  | { id: string; status: "failed"; code: string; message: string };

export type BatchImageUpdateResponse = {
  requested: number;
  updated: number;
  failed: number;
  results: BatchImageUpdateItemResult[];
};

export type BatchStorageMigrationResponse = {
  migrated: number;
  unchanged: number;
  failed: number;
};

export type ApiErrorResponse = {
  ok: false;
  code: string;
  error: string;
  details?: unknown;
};

export type ApiSuccessResponse<T extends Record<string, unknown>> = {
  ok: true;
} & T;

export type FacetOptionDto = {
  slug: string;
  display_name: string;
};

export type GalleryFacetsDto = {
  devices: string[];
  brightnesses: string[];
  themes: FacetOptionDto[];
  tags: FacetOptionDto[];
  authors: Array<FacetOptionDto & { link: string }>;
};

export type GalleryImageCardDto = {
  id: string;
  title: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  author: string;
  thumb_url: string;
  width: number;
  height: number;
  tags: string[];
  diff_original: boolean;
  image_time: string | null;
};

export type PublicImageDetailDto = {
  id: string;
  description: string;
  object_url: string;
  source: string;
};

export type PublicImageItemDto = GalleryImageCardDto & PublicImageDetailDto;

export type AdminImageItemDto = PublicImageItemDto & {
  status: "ready" | "deleted";
  object_key: string;
  storage_slug: string;
  is_link: boolean;
  md5: string;
  original: string;
  image_size?: number;
  deleted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type AdminImageListResponse = {
  items: AdminImageItemDto[];
  total: number;
  has_next: boolean;
  next_cursor: string | null;
};

export type ImageAdminInfoDto = {
  id: string;
  md5: string;
  storage_label: string;
  created_at: string;
  updated_at: string;
};

export type AuthStateDto = {
  authenticated: boolean;
  username: string;
  role: AdminRole | "";
  csrf_token: string;
  altcha_enabled: boolean;
  login_background: string;
};
