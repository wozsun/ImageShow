import type {
  Brightness,
  CompletedImportDisplayDto,
  Device,
  ImageDraftDto,
  ImportDuplicateDecision
} from "@imageshow/shared/browser";
import type { ImageExt } from "../processing.ts";

export const importQueueTypes = ["upload", "import"] as const;
export type ImportQueueType = typeof importQueueTypes[number];

export const importSourceTypes = ["upload", "url", "jsonl", "weibo"] as const;
export type ImportSourceType = typeof importSourceTypes[number];

export const importSessionStatuses = [
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
type ImportSessionStatus = typeof importSessionStatuses[number];

export type ImportSessionPair = Readonly<{
  session_id: string;
  image_id: string;
}>;

export function importSessionPairKey(pair: ImportSessionPair) {
  return `${pair.session_id}\0${pair.image_id.toLowerCase()}`;
}

export type RemoteImportDescription = Readonly<{
  url: string;
}>;

export type ImportPreparedManifest = Readonly<{
  prepared_image_key: string;
  prepared_thumbnail_key: string;
  original_size: number;
  original_width: number;
  original_height: number;
  width: number;
  height: number;
  ext: ImageExt;
  md5: string;
  prepared_image_sha256?: string;
  prepared_thumbnail_sha256?: string;
  size: number;
  thumbnail_size: number;
  quality: number | null;
  transcoded: boolean;
  detected_device: Device;
  detected_brightness: Brightness;
  duplicate_count: number;
  generation: string;
}>;

type ImportCommitIntent = Readonly<{
  commit_request_id: string;
  commit_intent_hash: string;
  created_by: string;
  expected_md5: string;
  duplicate_decision: ImportDuplicateDecision;
  metadata: ImageDraftDto;
  final_object_key: string;
}>;

export type ImportSessionError = Readonly<{
  code: string;
  message: string;
}>;

/**
 * The complete, recoverable Redis truth for one accepted but unfinished task.
 * Paths are always derived from the pair and generation values; this object
 * never stores a host path or image bytes.
 */
export type ImportSessionSnapshot = ImportSessionPair & Readonly<{
  owner: string;
  queue: ImportQueueType;
  source_type: ImportSourceType;
  manifest_position?: number;
  manifest_line?: number;
  image_time: string;
  request_hash: string;
  remote?: RemoteImportDescription;
  metadata: ImageDraftDto;
  storage_slug: string;
  status: Exclude<ImportSessionStatus, "completed" | "discarded">;
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
  prepared?: ImportPreparedManifest;
  duplicate_decision?: ImportDuplicateDecision;
  commit?: ImportCommitIntent;
  error?: ImportSessionError;
  discard_at: number;
  semantic_hash: string;
}>;

export function completedImportDisplay(
  session: ImportSessionSnapshot
): CompletedImportDisplayDto | undefined {
  if (!session.prepared) return undefined;
  return {
    source_type: session.source_type,
    ...(session.manifest_position === undefined
      ? {}
      : { manifest_position: session.manifest_position }),
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

export type CompletedImportReceipt = ImportSessionPair & Readonly<{
  owner: string;
  queue: ImportQueueType;
  request_hash: string;
  commit_request_id: string;
  commit_intent_hash: string;
  status: "completed";
  version: number;
  last_semantic_revision: number;
  accepted_at: number;
  accepted_order: number;
  completed_at: number;
  display?: CompletedImportDisplayDto;
  discard_at: number;
}>;

export type DiscardedImportReceipt = ImportSessionPair & Readonly<{
  owner: string;
  queue: ImportQueueType;
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

export type StoredImportSession =
  | ImportSessionSnapshot
  | CompletedImportReceipt
  | DiscardedImportReceipt;

export type UploadIntentSnapshot = Readonly<{
  owner: string;
  session_id: string;
  candidate_image_id: string;
  resolved_image_time: string;
  request_hash: string;
  display_order_key: string;
  manifest_position: number;
  metadata: ImageDraftDto;
  storage_slug: string;
  expected_size: number;
  max_long_edge: number;
  created_at: number;
  expires_at: number;
  execution_token: string;
  claim_heartbeat_at: number;
}>;

export type ImportQueueSummary = Readonly<{
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

export type ImportQueueMetadata = ImportQueueSummary & Readonly<{
  owner: string;
  queue: ImportQueueType;
  revision: number;
  last_accepted_order: number;
}>;

export type ImportQueueSnapshot = Readonly<{
  metadata: ImportQueueMetadata;
  offset: number;
  limit: number;
  items: StoredImportSession[];
  staleItems: ImportSessionPair[];
}>;
