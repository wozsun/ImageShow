import type { AdminRole, LogLevel } from "./common.ts";
import type { AdminImageDetailItemDto } from "./images.ts";

export type AdvancedConfigBackendPreviewDto = {
  slug: string;
  display_name: string;
  enabled: boolean;
  is_default: boolean;
};

export type AdvancedConfigPreviewDto = {
  format: string | null;
  application_version: string | null;
  exported_at: string | null;
  config_values: {
    recognized: number;
    defaulted: number;
    ignored: number;
  };
  storage_backends: AdvancedConfigBackendPreviewDto[];
  skipped_storage_backends: number;
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
    current_core_memory_bytes: number | null;
    current_core_measured_at: string | null;
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
  image_projection: ReadyImageCacheAdminStatusDto;
};

export type AdminCheckStatusDto = {
  postgresql: AdminCheckResourceDto<AdminPostgresqlStatusDto>;
  redis: AdminCheckResourceDto<AdminRedisStatusDto>;
};

export type TrashPurgeJobStateDto =
  | "pending"
  | "running"
  | "retrying"
  | "exhausted";

export type AdminTrashPurgeJobDto = {
  id: string;
  state: TrashPurgeJobStateDto;
  image_count: number;
  retry_count: number;
  next_retry_at: string | null;
  updated_at: string;
  error: string;
};

export type AdminTrashCheckIssueDto = {
  kind:
    | "missing_job_reference"
    | "wrong_job_type"
    | "succeeded_job_reference"
    | "stalled_job";
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

export type TrashPurgeMaintenanceRequestDto =
  | { action: "retry"; job_id: string }
  | { action: "repair" };

export type TrashPurgeMaintenanceResponseDto = {
  action: TrashPurgeMaintenanceRequestDto["action"];
  affected_jobs: number;
  affected_images: number;
  skipped_jobs: number;
};
