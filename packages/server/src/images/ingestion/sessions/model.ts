import type {
  Brightness,
  CompletedIngestionDisplayDto,
  Device,
  ImageDraftDto,
  IngestionDuplicateDecision
} from "@imageshow/shared/browser";
import type { ImageExt } from "../../processing.ts";

export const ingestionQueueTypes = ["upload", "import"] as const;
export type IngestionQueueType = typeof ingestionQueueTypes[number];

export const ingestionSourceTypes = ["upload", "url", "jsonl", "weibo"] as const;
export type IngestionSourceType = typeof ingestionSourceTypes[number];

export const ingestionSessionStatuses = [
  "queued",
  "downloading",
  "received",
  "preparing",
  "ready",
  "committing",
  "resolving",
  "completed",
  "failed",
  "discarded"
] as const;
type IngestionSessionStatus = typeof ingestionSessionStatuses[number];

export type IngestionSessionPair = Readonly<{
  session_id: string;
  image_id: string;
}>;

export function ingestionSessionPairKey(pair: IngestionSessionPair) {
  return `${pair.session_id}\0${pair.image_id.toLowerCase()}`;
}

export type ImportDownload = Readonly<{
  url: string;
}>;

export type IngestionPreparedManifest = Readonly<{
  prepared_image_key: string;
  prepared_thumbnail_key: string;
  original_size: number;
  original_width: number;
  original_height: number;
  width: number;
  height: number;
  ext: ImageExt;
  md5: string;
  prepared_image_sha256: string;
  prepared_thumbnail_sha256: string;
  size: number;
  thumbnail_size: number;
  quality: number | null;
  transcoded: boolean;
  detected_device: Device;
  detected_brightness: Brightness;
  duplicate_count: number;
  generation: string;
}>;

type IngestionCommitIntent = Readonly<{
  commit_request_id: string;
  commit_intent_hash: string;
  created_by: string;
  expected_md5: string;
  duplicate_decision: IngestionDuplicateDecision;
  metadata: ImageDraftDto;
  final_object_key: string;
}>;

export type IngestionSessionError = Readonly<{
  code: string;
  message: string;
}>;

/**
 * The complete, recoverable Redis truth for one accepted but unfinished task.
 * Paths are always derived from the pair and generation values; this object
 * never stores a host path or image bytes.
 */
export type IngestionSessionSnapshot = IngestionSessionPair & Readonly<{
  owner: string;
  queue: IngestionQueueType;
  source_type: IngestionSourceType;
  batch_position?: number;
  manifest_line?: number;
  image_time: string;
  request_hash: string;
  import_download?: ImportDownload;
  metadata: ImageDraftDto;
  storage_slug: string;
  status: Exclude<IngestionSessionStatus, "completed" | "discarded">;
  phase: string;
  message: string;
  progress: number | null;
  version: number;
  progress_seq: number;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
  execution_token: string;
  raw_generation: string;
  raw_size: number;
  prepared?: IngestionPreparedManifest;
  duplicate_decision?: IngestionDuplicateDecision;
  commit?: IngestionCommitIntent;
  error?: IngestionSessionError;
  discard_at: number;
  semantic_hash: string;
}>;

export function completedIngestionDisplay(
  session: IngestionSessionSnapshot
): CompletedIngestionDisplayDto | undefined {
  if (!session.prepared) return undefined;
  return {
    source_type: session.source_type,
    ...(session.batch_position === undefined
      ? {}
      : { batch_position: session.batch_position }),
    ...(session.manifest_line === undefined
      ? {}
      : { manifest_line: session.manifest_line }),
    original_width: session.prepared.original_width,
    original_height: session.prepared.original_height,
    original_size: session.prepared.original_size,
    quality: session.prepared.quality,
    transcoded: session.prepared.transcoded
  };
}

export type CompletedIngestionReceipt = IngestionSessionPair & Readonly<{
  owner: string;
  queue: IngestionQueueType;
  request_hash: string;
  commit_request_id: string;
  commit_intent_hash: string;
  status: "completed";
  version: number;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
  completed_at: number;
  display?: CompletedIngestionDisplayDto;
  discard_at: number;
}>;

export type DiscardedIngestionReceipt = IngestionSessionPair & Readonly<{
  owner: string;
  queue: IngestionQueueType;
  image_time: string;
  request_hash: string;
  status: "discarded";
  version: number;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
  discarded_at: number;
  discard_at: number;
}>;

export type StoredIngestionSession =
  | IngestionSessionSnapshot
  | CompletedIngestionReceipt
  | DiscardedIngestionReceipt;

export type UploadIntentSnapshot = Readonly<{
  owner: string;
  session_id: string;
  candidate_image_id: string;
  resolved_image_time: string;
  request_hash: string;
  display_order_key: string;
  batch_position: number;
  metadata: ImageDraftDto;
  storage_slug: string;
  expected_size: number;
  max_long_edge: number;
  created_at: number;
  expires_at: number;
  execution_token: string;
  claim_heartbeat_at: number;
}>;

export type IngestionQueueSummary = Readonly<{
  total: number;
  unfinished: number;
  waiting: number;
  running: number;
  ready: number;
  duplicate_pending: number;
  committing_resolving: number;
  resolving: number;
  completed: number;
  failed: number;
}>;

export type IngestionQueueMetadata = IngestionQueueSummary & Readonly<{
  owner: string;
  queue: IngestionQueueType;
  revision: number;
  last_accepted_order: number;
}>;

export type IngestionQueueSnapshot = Readonly<{
  metadata: IngestionQueueMetadata;
  offset: number;
  limit: number;
  items: StoredIngestionSession[];
  staleItems: IngestionSessionPair[];
}>;
