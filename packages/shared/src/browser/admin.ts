import type { LogLevel } from "./log-levels.ts";
import type { AdminImageRecentItemDto } from "./images.ts";

export type LogFileSummaryDto = {
  name: string;
  size: number;
  modified_at: string;
};

export type AdminLogPayloadDto = {
  level: LogLevel;
  files: LogFileSummaryDto[];
  selected: string;
  limit_bytes: number;
  content: string;
  truncated: boolean;
  bytes_read: number;
};

export type AdminLogLevelDto = {
  level: LogLevel;
};

export type AdminOverviewDto = {
  gallery: number;
  total: number;
  local: number;
  nonlocal: number;
  local_large_bytes: number;
  local_small_bytes: number;
  local_medium_bytes: number;
  nonlocal_large_bytes: number;
  nonlocal_small_bytes: number;
  nonlocal_medium_bytes: number;
  theme_count: number;
  tag_count: number;
  author_count: number;
  backend_count: number;
  pc: number;
  mb: number;
  dark: number;
  light: number;
  top_themes: Array<{ theme: string; count: number }>;
  recent: AdminImageRecentItemDto[];
  ready_image_cache: {
    state: string;
    synchronized: boolean;
    rebuilding: boolean;
    item_count: number | null;
    current_core_memory_bytes: number | null;
    current_core_measured_at: string | null;
    last_full_rebuild_core_memory_bytes: number | null;
    last_full_rebuild_measured_at: string | null;
  };
};

export type AdminCheckErrorCategory =
  "connection" | "query" | "command" | "projection" | "storage" | "unknown";

export type AdminCheckFailureDto = {
  category: AdminCheckErrorCategory;
  code: string;
  message: string;
};

export type AdminCheckResourceDto<T> =
  | { status: "ok"; data: T; error: null }
  | { status: "error"; data: null; error: AdminCheckFailureDto };

export type ReadyImageCacheRecentErrorDto = {
  category: "core" | "derived";
  code: string;
  message: string;
  occurred_at: string;
};

export type ReadyImageCacheAdminStatusDto = {
  readable: boolean;
  rebuilding: boolean;
  synchronized: boolean | null;
  state: string;
  reason: string;
  authoritative_revision: string | null;
  applied_revision: string | null;
  item_count: number | null;
  processed: number | null;
  total: number | null;
  last_updated_at: string | null;
  full_rebuild_started_at: string | null;
  full_rebuild_completed_at: string | null;
  full_rebuild_duration_ms: number | null;
  last_full_rebuild_core_memory_bytes: number | null;
  last_full_rebuild_measured_at: string | null;
  recent_errors: {
    core: ReadyImageCacheRecentErrorDto | null;
    derived: ReadyImageCacheRecentErrorDto | null;
  };
};

export type AdminPostgresqlStatusDto = {
  connection: "connected";
  version: string;
  latency_ms: number;
  ready_images: number;
  total_images: number;
  authoritative_revision: string;
  abnormal_jobs: number;
};

export type AdminRedisStatusDto = {
  connection: "connected";
  version: string;
  configured_db: number;
  latency_ms: number;
  memory: {
    scope: "redis_instance";
    used_memory_bytes: number | null;
    used_memory_rss_bytes: number | null;
    fragmentation_ratio: number | null;
  };
  ready_image_cache: ReadyImageCacheAdminStatusDto;
};

export type AdminCheckStatusDto = {
  postgresql: AdminCheckResourceDto<AdminPostgresqlStatusDto>;
  redis: AdminCheckResourceDto<AdminRedisStatusDto>;
};

export type TrashPurgeJobStateDto = "pending" | "running" | "retrying" | "exhausted";

export type AdminTrashPurgeJobDto = {
  id: string;
  state: TrashPurgeJobStateDto;
  target_id: string;
  retry_count: number;
  next_retry_at: string | null;
  updated_at: string;
  error: string;
};

export type AdminTrashCheckIssueDto = {
  kind: "succeeded_target_remaining" | "target_not_deleted" | "stalled_job";
  count: number;
  sample_ids: string[];
};

export type AdminTrashCheckDto = {
  deleted_count: number;
  unqueued_count: number;
  purge_pending_count: number;
  job_counts: Record<TrashPurgeJobStateDto, number>;
  jobs: AdminTrashPurgeJobDto[];
  issues: AdminTrashCheckIssueDto[];
  candidates: Array<{
    id: string;
    object_key: string;
    deleted_at: string;
    purge_pending: boolean;
  }>;
};

export const adminImagePageLimit = 60;

export const adminBasePath = "/admin";

export const adminApiBasePath = "/api/admin";

export const adminImageSortFields = ["image_time", "created_at"] as const;

export const adminImageOrders = ["latest", "oldest"] as const;

export type AdminImageSort = {
  sort_by: (typeof adminImageSortFields)[number];
  order: (typeof adminImageOrders)[number];
};

export const defaultAdminImageSort: Readonly<AdminImageSort> = {
  sort_by: "image_time",
  order: "latest"
};

// 管理端界面偏好以 PostgreSQL 为权威，并由浏览器本地存储提供首帧与离线兜底。
// 将键和值域集中在 shared；新增偏好时，类型、服务端校验和前端投影会同步暴露缺口。
const adminColorSchemes = ["light", "dark", "system"] as const;

const vocabularyViewModes = ["list", "card"] as const;

export const adminPreferenceValueOptions = {
  color_scheme: adminColorSchemes,
  image_sort_by: adminImageSortFields,
  image_sort_order: adminImageOrders,
  image_thumbnail_fit: ["cover", "contain"],
  theme_view_mode: vocabularyViewModes,
  tag_view_mode: vocabularyViewModes,
  author_view_mode: vocabularyViewModes,
  group_view_mode: vocabularyViewModes
} as const;

export const adminPreferencesMaxBytes = 4 * 1024;

export type AdminColorScheme = (typeof adminColorSchemes)[number];

export type AdminPreferenceKey = keyof typeof adminPreferenceValueOptions;

export const adminPreferenceKeys = Object.freeze(
  Object.keys(adminPreferenceValueOptions) as AdminPreferenceKey[]
);

export type AdminPreferenceValues = {
  [Key in AdminPreferenceKey]: (typeof adminPreferenceValueOptions)[Key][number];
};

export const defaultAdminPreferences: Readonly<AdminPreferenceValues> = Object.freeze({
  color_scheme: "system",
  image_sort_by: defaultAdminImageSort.sort_by,
  image_sort_order: defaultAdminImageSort.order,
  image_thumbnail_fit: "cover",
  theme_view_mode: "card",
  tag_view_mode: "card",
  author_view_mode: "card",
  group_view_mode: "card"
});

export type AdminPreferences = Partial<AdminPreferenceValues>;

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

export type AdminPreferencesResponseDto = {
  preferences: AdminPreferences;
};
