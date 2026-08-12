import type { AdminRole, LogLevel } from "./common.ts";
import type { AdminImageDetailItemDto } from "./images.ts";

export type AdvancedConfigBackendPreviewDto = {
  slug: string;
  display_name: string;
  enabled: boolean;
  is_default: boolean;
};

export type AdvancedConfigPreviewDto = {
  format: "imageshow-config";
  format_version: number;
  application_version: string;
  exported_at: string;
  config_groups: number;
  storage_backends: AdvancedConfigBackendPreviewDto[];
  conflicts: string[];
  existing_slugs: string[];
};

export type AdvancedConfigPreviewResponseDto = {
  preview: AdvancedConfigPreviewDto;
};

export type AdminUserDto = {
  username: string;
  role: AdminRole;
};

export type AdminUsersResponseDto = {
  items: AdminUserDto[];
};

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
  theme_unset: number;
  trash: number;
  total: number;
  local: number;
  nonlocal: number;
  local_image_size: number;
  local_thumb_size: number;
  nonlocal_image_size: number;
  nonlocal_thumb_size: number;
  theme_count: number;
  backend_count: number;
  pc: number;
  mb: number;
  dark: number;
  light: number;
  top_themes: Array<{ theme: string; count: number }>;
  recent: AdminImageDetailItemDto[];
  redis_cache: {
    state: string;
    synchronized: boolean;
    rebuilding: boolean;
    item_count: number | null;
    last_full_rebuild_core_memory_bytes: number | null;
    last_full_rebuild_measured_at: string | null;
  };
};

export type AdminCheckErrorCategory =
  | "connection"
  | "query"
  | "command"
  | "projection"
  | "storage"
  | "unknown";

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
  image_projection: ReadyImageCacheAdminStatusDto;
};

export type AdminCheckStatusDto = {
  postgresql: AdminCheckResourceDto<AdminPostgresqlStatusDto>;
  redis: AdminCheckResourceDto<AdminRedisStatusDto>;
};
