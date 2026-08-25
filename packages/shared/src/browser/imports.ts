import type { Brightness, Device } from "./common.ts";
import type {
  AdminImageListItemDto,
  FacetOptionDto,
  ImageDraftDto
} from "./images.ts";

export const importStatusBatchMaxItems = 100;
export const importDuplicateDecisions = ["upload", "confirmed"] as const;
export type ImportDuplicateDecision =
  (typeof importDuplicateDecisions)[number];

export type JsonlManifestItemDto = {
  line: number;
  manifest_position: number;
  original: string;
  source?: string;
  image_time?: string;
  author?: string;
  tags?: string[];
  title?: string;
  description?: string;
  theme?: string;
  device?: Device | "auto";
  brightness?: Brightness | "auto";
  storage_slug?: string;
};

export type JsonlManifestParseErrorDto = {
  line: number;
  raw: string;
  error: string;
};

export type JsonlManifestResultDto = {
  items: JsonlManifestItemDto[];
  errors: JsonlManifestParseErrorDto[];
};

export type WeiboImportParseErrorDto = {
  line: number;
  url: string;
  error: string;
};

export type WeiboImportResultDto = {
  post_count: number;
  errors: WeiboImportParseErrorDto[];
  manifest: JsonlManifestResultDto;
};

export type ImportVocabularyDto = {
  themes: FacetOptionDto[];
  tags: FacetOptionDto[];
  authors: FacetOptionDto[];
};

export const uploadIntentPath = "/api/admin/imports/upload-intents";
export const uploadRawPath = "/api/admin/imports/upload-raw";
export const remoteImportAcceptPath = "/api/admin/imports/remote-accept";
export const importStatusPath = "/api/admin/imports/status";
export const importCommitPath = "/api/admin/imports/commit";
export const importCancelPath = "/api/admin/imports/cancel";
export const importUpdatePath = "/api/admin/imports/update";
export const importActionPath = "/api/admin/imports/action";
export const importDuplicatesPath = "/api/admin/imports/duplicates";
export const importSnapshotPath = "/api/admin/imports/snapshot";
export const importEventsPath = "/api/admin/imports/events";
export const importActionScopeHeader = "x-imageshow-import-action-scope";
export const uploadCredentialHeader = "x-imageshow-upload-credential";

export const importQueueTypes = ["upload", "import"] as const;
export type ImportQueueTypeDto = typeof importQueueTypes[number];

export const importSourceTypes = ["upload", "url", "jsonl", "weibo"] as const;
export type ImportSourceTypeDto = typeof importSourceTypes[number];

export const serverImportStatuses = [
  "queued",
  "downloading",
  "received",
  "preparing",
  "ready",
  "committing",
  "resolving",
  "completed",
  "failed"
] as const;
export type ServerImportStatusDto = typeof serverImportStatuses[number];

export type ImportSessionPairDto = {
  session_id: string;
  image_id: string;
};

export type UploadIntentItemInputDto = ImageDraftDto & {
  idempotency_key: string;
  batch_key: string;
  image_time?: string;
  batch_time?: string;
  manifest_position: number;
  storage_slug?: string;
  expected_size: number;
  max_long_edge: number;
};

export type UploadIntentInputDto = {
  items: UploadIntentItemInputDto[];
};

export type UploadIntentItemDto = {
  session_id: string;
  candidate_image_id: string;
  resolved_image_time: string;
  request_hash: string;
  credential: string;
  expires_at: number;
  status: "intent";
} | {
  session_id: string;
  image_id: string;
  resolved_image_time: string;
  request_hash: string;
  status: "accepted";
  accepted_order: number;
  version: number;
  last_semantic_revision: number;
} | {
  session_id: string;
  image_id: string;
  resolved_image_time: string;
  request_hash: string;
  status: "completed";
  accepted_order: number;
  version?: number;
  last_semantic_revision?: number;
} | {
  session_id: string;
  image_id: string;
  resolved_image_time: string;
  request_hash: string;
  status: "discarded";
  accepted_order: number;
} | {
  idempotency_key: string;
  status: "failed";
  code: string;
  message: string;
};

export type UploadIntentResultDto = {
  items: UploadIntentItemDto[];
};

export type UploadRawResultDto = ImportSessionPairDto & {
  status: "accepted";
  accepted_order: number;
  version: number;
  last_semantic_revision: number;
};

export type RemoteImportItemInputDto = ImageDraftDto & {
  idempotency_key: string;
  batch_key: string;
  source_type: Exclude<ImportSourceTypeDto, "upload">;
  url: string;
  image_time?: string;
  batch_time?: string;
  manifest_position: number;
  manifest_line?: number;
  storage_slug?: string;
};

export type RemoteImportAcceptInputDto = {
  items: RemoteImportItemInputDto[];
};

export type RemoteImportAcceptItemDto = (ImportSessionPairDto & {
  resolved_image_time: string;
  request_hash: string;
  status: "accepted";
  accepted_order: number;
  version: number;
  last_semantic_revision: number;
}) | (ImportSessionPairDto & {
  resolved_image_time: string;
  request_hash: string;
  status: "completed";
  accepted_order: number;
  version?: number;
  last_semantic_revision?: number;
}) | (ImportSessionPairDto & {
  resolved_image_time: string;
  request_hash: string;
  status: "discarded";
  accepted_order: number;
}) | {
  idempotency_key: string;
  status: "failed";
  code: string;
  message: string;
};

export type RemoteImportAcceptResultDto = {
  items: RemoteImportAcceptItemDto[];
};

export type ServerImportPreparedDto = {
  preview_url: string;
  preview_full_url: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  md5: string;
  original_size: number;
  size: number;
  quality: number | null;
  transcoded: boolean;
  detected_device: Device;
  detected_brightness: Brightness;
  storage_slug: string;
  duplicate_count: number;
};

export type ActiveServerImportItemDto = ImportSessionPairDto & {
  queue: ImportQueueTypeDto;
  source_type: ImportSourceTypeDto;
  source_url?: string;
  manifest_position?: number;
  manifest_line?: number;
  resolved_image_time: string;
  status: Exclude<ServerImportStatusDto, "completed">;
  phase: string;
  message: string;
  progress?: number;
  version: number;
  progress_seq: number;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
  metadata: ImageDraftDto;
  storage_slug: string;
  prepared?: ServerImportPreparedDto;
  duplicate_decision?: ImportDuplicateDecision;
  commit?: {
    commit_request_id: string;
    expected_md5: string;
    duplicate_decision: ImportDuplicateDecision;
    metadata: ImageDraftDto;
  };
  error?: { code: string; message: string };
};

export type CompletedImportDisplayDto = {
  source_type: ImportSourceTypeDto;
  manifest_position?: number;
  manifest_line?: number;
  original_width: number;
  original_height: number;
  original_size: number;
  quality: number | null;
  transcoded: boolean;
};

export type CompletedServerImportItemDto = ImportSessionPairDto & {
  queue: ImportQueueTypeDto;
  status: "completed";
  version: number;
  progress_seq: 0;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
  completed_at: number;
  display?: CompletedImportDisplayDto;
  completed_item: AdminImageListItemDto;
};

export type ServerImportItemDto =
  | ActiveServerImportItemDto
  | CompletedServerImportItemDto;

export type ImportQueueSummaryDto = {
  total: number;
  unfinished: number;
  waiting: number;
  running: number;
  ready: number;
  duplicate_pending: number;
  committing: number;
  resolving: number;
  completed: number;
  failed: number;
};

export type ImportQueueSnapshotDto = ImportQueueSummaryDto & {
  queue: ImportQueueTypeDto;
  revision: number;
  last_accepted_order: number;
  offset: number;
  limit: number;
  items: ServerImportItemDto[];
  stale_items: ImportSessionPairDto[];
  action_watermark: string;
};

export type ImportQueueSnapshotInputDto = {
  queue: ImportQueueTypeDto;
  offset: number;
  limit: number;
  exclude_items: ImportSessionPairDto[];
  include_items: ImportSessionPairDto[];
};

export type ImportQueueTerminalEventItemDto = ImportSessionPairDto & {
  status: "completed" | "discarded";
  version: number;
  progress_seq: 0;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
};

export type ImportQueueEventDto = {
  type: "ready";
  queue: ImportQueueTypeDto;
  revision: number;
  action_scope: string;
} | {
  type: "mutation";
  queue: ImportQueueTypeDto;
  kind: "semantic" | "progress" | "removed";
  revision: number;
  last_accepted_order: number;
  summary: ImportQueueSummaryDto;
  session: ServerImportItemDto | ImportQueueTerminalEventItemDto;
  action_watermark?: string;
} | {
  type: "ping";
  queue: ImportQueueTypeDto;
};

export type ImportStatusInputDto = {
  items: ImportSessionPairDto[];
};

export type ImportStatusItemDto = ImportSessionPairDto & (
  | { status: "present"; item: ActiveServerImportItemDto }
  | {
      status: "completed";
      completed_item: AdminImageListItemDto;
      display?: CompletedImportDisplayDto;
      redis_status: "active" | "completed" | "missing";
      redis_version?: number;
      redis_last_semantic_revision?: number;
    }
  | { status: "missing" }
);

export type ImportStatusResultDto = {
  items: ImportStatusItemDto[];
};

export type ImportSessionUpdateItemDto = ImportSessionPairDto & {
  expected_version: number;
  metadata?: ImageDraftDto;
  duplicate_decision?: ImportDuplicateDecision;
};

export type ImportSessionUpdateInputDto = {
  items: ImportSessionUpdateItemDto[];
};

export type ImportSessionUpdateItemResultDto = ImportSessionPairDto & (
  | {
      status: "changed" | "unchanged";
      version: number;
      last_semantic_revision: number;
      duplicate_count: number;
      duplicate_decision: ImportDuplicateDecision;
    }
  | { status: "failed"; code: string; message: string }
);

export type ImportSessionUpdateResultDto = {
  items: ImportSessionUpdateItemResultDto[];
};

export type ImportDuplicateDetailsInputDto = {
  md5s: string[];
};

export type ImportDuplicateDetailsResultDto = {
  items: Array<{
    md5: string;
    match_count: number;
    duplicates: AdminImageListItemDto[];
  }>;
};

export type ImportCommitItemInputDto = ImportSessionPairDto & {
  expected_version: number;
  expected_md5: string;
  commit_request_id: string;
  duplicate_decision: ImportDuplicateDecision;
  metadata: ImageDraftDto;
};

export type ImportCommitItemResultDto = ImportSessionPairDto & (
  | { status: "accepted"; version: number }
  | {
      status: "completed";
      version: number;
      completed_item: AdminImageListItemDto;
    }
  | {
      status: "failed";
      code: string;
      message: string;
      version?: number;
      duplicate_count?: number;
      duplicates?: AdminImageListItemDto[];
    }
);

export type ImportCommitInputDto = {
  items: ImportCommitItemInputDto[];
};

export type ImportCommitResultDto = {
  items: ImportCommitItemResultDto[];
};

export type ImportCancelItemInputDto = ImportSessionPairDto & {
  expected_version: number;
};

export type ImportCancelInputDto = {
  items: ImportCancelItemInputDto[];
};

export type ImportCancelItemResultDto = ImportSessionPairDto & (
  | { status: "discarded" }
  | { status: "resolving" }
  | { status: "completed"; completed_item: AdminImageListItemDto }
  | { status: "failed"; code?: string; message?: string }
);

export type ImportCancelResultDto = {
  items: ImportCancelItemResultDto[];
};

export const importQueueActionTypes = [
  "apply_metadata",
  "commit_ready",
  "clear_duplicate_pending",
  "clear_uncommitted",
  "clear_completed",
  "clear_queue"
] as const;
export type ImportQueueActionTypeDto = typeof importQueueActionTypes[number];

export type ImportQueueActionInputDto = {
  queue: ImportQueueTypeDto;
  action_request_id: string;
  action: ImportQueueActionTypeDto;
  action_watermark: string;
  continuation?: string;
  metadata?: Partial<ImageDraftDto>;
  max_semantic_revision?: number;
};

export type ImportQueueActionResultDto = {
  processed: number;
  changed: number;
  failed: number;
  continuation?: string;
  items: Array<ImportSessionPairDto & {
    status: "changed" | "unchanged" | "skipped" | "failed";
    code?: string;
    message?: string;
    completed_item?: AdminImageListItemDto;
  }>;
};
