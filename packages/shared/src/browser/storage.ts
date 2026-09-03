import type { ApiSuccessResponseDto } from "./common.ts";

export const storageLayoutUpgradeBatchMaxItems = 100;

export type StorageLayoutUpgradeNamespaceDto = {
  namespace: string;
  backends: string[];
  media_objects: number | null;
  complete: boolean;
  error: string;
};

export type StorageLayoutUpgradeStatusDto = {
  total_images: number;
  compliant_images: number;
  remaining_images: number;
  invalid_layout_images: number;
  estimated_transfer_bytes: number;
  active_legacy_ingestions: number;
  pending_media_cleanup_jobs: number;
  media_objects: number | null;
  media_listing_complete: boolean;
  namespaces: StorageLayoutUpgradeNamespaceDto[];
  projection: {
    authoritative_revision: string;
    applied_revision: string | null;
    synchronized: boolean;
  };
  can_migrate: boolean;
  complete: boolean;
};

export type StorageLayoutUpgradeItemResultDto =
  | { id: string; status: "migrated" | "unchanged" }
  | { id: string; status: "failed"; code: string; message: string };

export type StorageLayoutUpgradeBatchResponseDto = {
  batch: {
    requested: number;
    migrated: number;
    unchanged: number;
    failed: number;
    results: StorageLayoutUpgradeItemResultDto[];
  };
  status: StorageLayoutUpgradeStatusDto;
};

export type StorageBackendDeleteBlocker =
  | "built_in"
  | "default"
  | "images"
  | "ingestion_sessions"
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

export type ImageStorageMigrationItemResultDto =
  | { id: string; status: "migrated" | "unchanged" }
  | { id: string; status: "failed"; code: string; message: string };

export type ImageStorageMigrationResponseDto = {
  migrated: number;
  failed: number;
  storage_label: string;
  results: ImageStorageMigrationItemResultDto[];
};

export type StorageBackendMigrationErrorSampleDto = {
  id: string;
  object_key: string;
  code: string;
  message: string;
};

export type StorageBackendMigrationResultDto = {
  source: string;
  target: string;
  migrated: number;
  unchanged: number;
  missing: number;
  error_samples: StorageBackendMigrationErrorSampleDto[];
  error_count: number;
};

export type StorageBackendMigrationResponseDto = ApiSuccessResponseDto<{
  migration: StorageBackendMigrationResultDto;
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
  connect_timeout_seconds: number;
  idle_timeout_seconds: number;
  task_timeout_seconds: number;
  secret_access_key_configured: boolean;
};

type StorageBackendAdminBaseDto = StorageBackendOptionDto & {
  image_count: number;
  ingestion_session_count: number;
  cleanup_job_count: number;
  failed_cleanup_job_count: number;
  exhausted_cleanup_job_count: number;
  deletion: StorageBackendDeletionState;
};

export type StorageBackendAdminDto = StorageBackendAdminBaseDto & (
  | { type: "local" }
  | { type: "s3"; s3: StorageBackendS3Dto }
);

export type StorageBackendsAdminResponseDto = {
  backends: StorageBackendAdminDto[];
};
