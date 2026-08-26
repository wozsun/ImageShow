import type { Brightness, Device } from "./common.ts";
import type {
  AdminImageListItemDto,
  FacetOptionDto,
  ImageDraftDto
} from "./images.ts";

export const ingestionStatusBatchMaxItems = 100;
export const ingestionDuplicateDecisions = ["upload", "confirmed"] as const;
export type IngestionDuplicateDecision =
  (typeof ingestionDuplicateDecisions)[number];

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

export type IngestionVocabularyDto = {
  themes: FacetOptionDto[];
  tags: FacetOptionDto[];
  authors: FacetOptionDto[];
};

export const ingestionVocabularyPath = "/api/admin/ingestion/vocabulary";
export const uploadIntentPath = "/api/admin/ingestion/upload/intents";
export const uploadRawPath = "/api/admin/ingestion/upload/raw";
export const importAcceptPath = "/api/admin/ingestion/import/accept";
export const importJsonlParsePath = "/api/admin/ingestion/import/jsonl/parse";
export const importWeiboParsePath = "/api/admin/ingestion/import/weibo/parse";
export const ingestionStatusPath = "/api/admin/ingestion/status";
export const ingestionCommitPath = "/api/admin/ingestion/commit";
export const ingestionCancelPath = "/api/admin/ingestion/cancel";
export const ingestionUpdatePath = "/api/admin/ingestion/update";
export const ingestionActionPath = "/api/admin/ingestion/action";
export const ingestionDuplicatesPath = "/api/admin/ingestion/duplicates";
export const ingestionSnapshotPath = "/api/admin/ingestion/snapshot";
export const ingestionEventsPath = "/api/admin/ingestion/events";
export const ingestionPreviewPath = "/api/admin/ingestion/preview";
export const ingestionActionScopeHeader = "x-imageshow-ingestion-action-scope";
export const uploadCredentialHeader = "x-imageshow-upload-credential";

export const ingestionQueueTypes = ["upload", "import"] as const;
export type IngestionQueueTypeDto = typeof ingestionQueueTypes[number];

export const ingestionSourceTypes = ["upload", "url", "jsonl", "weibo"] as const;
export type IngestionSourceTypeDto = typeof ingestionSourceTypes[number];

export const serverIngestionStatuses = [
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
export type ServerIngestionStatusDto = typeof serverIngestionStatuses[number];

export type IngestionSessionPairDto = {
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

export type UploadRawResultDto = IngestionSessionPairDto & {
  status: "accepted";
  accepted_order: number;
  version: number;
  last_semantic_revision: number;
};

export type ImportItemInputDto = ImageDraftDto & {
  idempotency_key: string;
  batch_key: string;
  source_type: Exclude<IngestionSourceTypeDto, "upload">;
  url: string;
  image_time?: string;
  batch_time?: string;
  manifest_position: number;
  manifest_line?: number;
  storage_slug?: string;
};

export type ImportAcceptInputDto = {
  items: ImportItemInputDto[];
};

export type ImportAcceptItemDto = (IngestionSessionPairDto & {
  resolved_image_time: string;
  request_hash: string;
  status: "accepted";
  accepted_order: number;
  version: number;
  last_semantic_revision: number;
}) | (IngestionSessionPairDto & {
  resolved_image_time: string;
  request_hash: string;
  status: "completed";
  accepted_order: number;
  version?: number;
  last_semantic_revision?: number;
}) | (IngestionSessionPairDto & {
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

export type ImportAcceptResultDto = {
  items: ImportAcceptItemDto[];
};

export type ServerIngestionPreparedDto = {
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

export type ActiveServerIngestionItemDto = IngestionSessionPairDto & {
  queue: IngestionQueueTypeDto;
  source_type: IngestionSourceTypeDto;
  source_url?: string;
  manifest_position?: number;
  manifest_line?: number;
  resolved_image_time: string;
  status: Exclude<ServerIngestionStatusDto, "completed">;
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
  prepared?: ServerIngestionPreparedDto;
  duplicate_decision?: IngestionDuplicateDecision;
  commit?: {
    commit_request_id: string;
    expected_md5: string;
    duplicate_decision: IngestionDuplicateDecision;
    metadata: ImageDraftDto;
  };
  error?: { code: string; message: string };
};

export type CompletedIngestionDisplayDto = {
  source_type: IngestionSourceTypeDto;
  manifest_position?: number;
  manifest_line?: number;
  original_width: number;
  original_height: number;
  original_size: number;
  quality: number | null;
  transcoded: boolean;
};

export type CompletedServerIngestionItemDto = IngestionSessionPairDto & {
  queue: IngestionQueueTypeDto;
  status: "completed";
  version: number;
  progress_seq: 0;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
  completed_at: number;
  display?: CompletedIngestionDisplayDto;
  completed_item: AdminImageListItemDto;
};

export type ServerIngestionItemDto =
  | ActiveServerIngestionItemDto
  | CompletedServerIngestionItemDto;

export type IngestionQueueSummaryDto = {
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

export type IngestionQueueSnapshotDto = IngestionQueueSummaryDto & {
  queue: IngestionQueueTypeDto;
  revision: number;
  last_accepted_order: number;
  offset: number;
  limit: number;
  items: ServerIngestionItemDto[];
  stale_items: IngestionSessionPairDto[];
  action_watermark: string;
};

export type IngestionQueueSnapshotInputDto = {
  queue: IngestionQueueTypeDto;
  offset: number;
  limit: number;
  exclude_items: IngestionSessionPairDto[];
  include_items: IngestionSessionPairDto[];
};

export type IngestionQueueTerminalEventItemDto = IngestionSessionPairDto & {
  status: "completed" | "discarded";
  version: number;
  progress_seq: 0;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
};

export type IngestionQueueEventDto = {
  type: "ready";
  queue: IngestionQueueTypeDto;
  revision: number;
  action_scope: string;
} | {
  type: "mutation";
  queue: IngestionQueueTypeDto;
  kind: "semantic" | "progress" | "removed";
  revision: number;
  last_accepted_order: number;
  summary: IngestionQueueSummaryDto;
  session: ServerIngestionItemDto | IngestionQueueTerminalEventItemDto;
  action_watermark?: string;
} | {
  type: "ping";
  queue: IngestionQueueTypeDto;
};

export type IngestionStatusInputDto = {
  items: IngestionSessionPairDto[];
};

export type IngestionStatusItemDto = IngestionSessionPairDto & (
  | { status: "present"; item: ActiveServerIngestionItemDto }
  | {
      status: "completed";
      completed_item: AdminImageListItemDto;
      display?: CompletedIngestionDisplayDto;
      redis_status: "active" | "completed" | "missing";
      redis_version?: number;
      redis_last_semantic_revision?: number;
    }
  | { status: "missing" }
);

export type IngestionStatusResultDto = {
  items: IngestionStatusItemDto[];
};

export type IngestionSessionUpdateItemDto = IngestionSessionPairDto & {
  expected_version: number;
  metadata?: ImageDraftDto;
  duplicate_decision?: IngestionDuplicateDecision;
};

export type IngestionSessionUpdateInputDto = {
  items: IngestionSessionUpdateItemDto[];
};

export type IngestionSessionUpdateItemResultDto = IngestionSessionPairDto & (
  | {
      status: "changed" | "unchanged";
      version: number;
      last_semantic_revision: number;
      duplicate_count: number;
      duplicate_decision: IngestionDuplicateDecision;
    }
  | { status: "failed"; code: string; message: string }
);

export type IngestionSessionUpdateResultDto = {
  items: IngestionSessionUpdateItemResultDto[];
};

export type IngestionDuplicateDetailsInputDto = {
  md5s: string[];
};

export type IngestionDuplicateDetailsResultDto = {
  items: Array<{
    md5: string;
    match_count: number;
    duplicates: AdminImageListItemDto[];
  }>;
};

export type IngestionCommitItemInputDto = IngestionSessionPairDto & {
  expected_version: number;
  expected_md5: string;
  commit_request_id: string;
  duplicate_decision: IngestionDuplicateDecision;
  metadata: ImageDraftDto;
};

export type IngestionCommitItemResultDto = IngestionSessionPairDto & (
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

export type IngestionCommitInputDto = {
  items: IngestionCommitItemInputDto[];
};

export type IngestionCommitResultDto = {
  items: IngestionCommitItemResultDto[];
};

export type IngestionCancelItemInputDto = IngestionSessionPairDto & {
  expected_version: number;
};

export type IngestionCancelInputDto = {
  items: IngestionCancelItemInputDto[];
};

export type IngestionCancelItemResultDto = IngestionSessionPairDto & (
  | { status: "discarded" }
  | { status: "resolving" }
  | { status: "completed"; completed_item: AdminImageListItemDto }
  | { status: "failed"; code?: string; message?: string }
);

export type IngestionCancelResultDto = {
  items: IngestionCancelItemResultDto[];
};

export const ingestionQueueActionTypes = [
  "apply_metadata",
  "commit_ready",
  "clear_duplicate_pending",
  "clear_uncommitted",
  "clear_completed",
  "clear_queue"
] as const;
export type IngestionQueueActionTypeDto = typeof ingestionQueueActionTypes[number];

export type IngestionQueueActionInputDto = {
  queue: IngestionQueueTypeDto;
  action_request_id: string;
  action: IngestionQueueActionTypeDto;
  action_watermark: string;
  continuation?: string;
  metadata?: Partial<ImageDraftDto>;
  max_semantic_revision?: number;
};

export type IngestionQueueActionResultDto = {
  processed: number;
  changed: number;
  failed: number;
  continuation?: string;
  items: Array<IngestionSessionPairDto & {
    status: "changed" | "unchanged" | "skipped" | "failed";
    code?: string;
    message?: string;
    completed_item?: AdminImageListItemDto;
  }>;
};
