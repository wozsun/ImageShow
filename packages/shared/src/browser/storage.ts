import type { ApiSuccessResponse, StorageType } from "./common.ts";

export type StorageBackendDeleteBlocker =
  | "built_in"
  | "default"
  | "images"
  | "import_sessions"
  | "cleanup_jobs"
  | "staging_objects";

export type StorageBackendDeleteAction = "delete" | "migrate" | "blocked";

export type StorageBackendDeletionState = {
  action: StorageBackendDeleteAction;
  blockers: StorageBackendDeleteBlocker[];
};

export function storageBackendDeletionStateFromBlockers(
  blockers: readonly StorageBackendDeleteBlocker[]
): StorageBackendDeletionState {
  const uniqueBlockers = [...new Set(blockers)];
  return {
    action: uniqueBlockers.includes("images")
      ? "migrate"
      : uniqueBlockers.length
        ? "blocked"
        : "delete",
    blockers: uniqueBlockers
  };
}

export type BatchStorageMigrationResponse = {
  migrated: number;
  failed: number;
};

export type StorageLocationMigrationResult = {
  source: string;
  target: string;
  migrated: number;
  unchanged: number;
  missing: number;
  errors: Array<Record<string, unknown>>;
  error_count: number;
};

export type StorageLocationMigrationResponse = ApiSuccessResponse<{
  migration: StorageLocationMigrationResult;
}>;

export type StorageBackendOptionDto = {
  slug: string;
  display_name: string;
  enabled: boolean;
  is_default: boolean;
};

export type StorageBackendOptionsResponseDto = {
  backends: StorageBackendOptionDto[];
};

export type StorageBackendS3Dto = {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  force_path_style: boolean;
  root_path: string;
  public_base_url: string;
  secret_access_key_configured: boolean;
};

export type StorageBackendWebdavDto = {
  base_url: string;
  username: string;
  root_path: string;
  public_base_url: string;
  list_depth_infinity: boolean;
  connect_timeout_seconds: number;
  idle_timeout_seconds: number;
  task_timeout_seconds: number;
  password_configured: boolean;
};

type StorageBackendAdminBaseDto = StorageBackendOptionDto & {
  image_count: number;
  import_session_count: number;
  cleanup_job_count: number;
  failed_cleanup_job_count: number;
  exhausted_cleanup_job_count: number;
  deletion: StorageBackendDeletionState;
};

export type StorageBackendAdminDto = StorageBackendAdminBaseDto & (
  | { type: Extract<StorageType, "local"> }
  | { type: Extract<StorageType, "s3">; s3: StorageBackendS3Dto }
  | {
    type: Extract<StorageType, "webdav">;
    webdav: StorageBackendWebdavDto;
  }
);

export type StorageBackendsAdminResponseDto = {
  backends: StorageBackendAdminDto[];
};
