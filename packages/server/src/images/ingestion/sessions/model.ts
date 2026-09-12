import { z } from "zod";
import type { CompletedIngestionDisplayDto } from "@imageshow/shared/browser";

const ingestionQueueTypes = ["upload", "import"] as const;
export type IngestionQueueType = typeof ingestionQueueTypes[number];
const ingestionSourceTypes = ["upload", "url", "jsonl", "weibo"] as const;
export type IngestionSourceType = typeof ingestionSourceTypes[number];
const ingestionSessionStatuses = [
  "queued", "downloading", "received", "preparing", "ready", "committing",
  "resolving", "completed", "failed", "discarded"
] as const;

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.int().nonnegative();
const positiveInteger = z.int().positive();
const digest = (bytes: number) => z.string().regex(new RegExp(`^[a-f0-9]{${bytes * 2}}$`, "u"));
const batchPosition = nonNegativeInteger.max(0xfff);
const manifestLine = positiveInteger.max(1_000_000);
const duplicateDecision = z.enum(["upload", "confirmed"]);

// Stored metadata expresses the Redis protocol, without HTTP trimming,
// defaults or stricter business-field validation.
const draftSchema = z.strictObject({
  device: z.enum(["pc", "mb", "auto"]),
  brightness: z.enum(["dark", "light", "auto"]),
  theme: z.string().nullable(),
  author: z.string(),
  title: z.string(),
  description: z.string(),
  source: z.string(),
  original: z.string(),
  tags: z.array(z.string())
});
const pairShape = { session_id: nonEmptyString, image_id: nonEmptyString };
const pairSchema = z.strictObject(pairShape);
export type IngestionSessionPair = Readonly<z.infer<typeof pairSchema>>;

export function ingestionSessionPairKey(pair: IngestionSessionPair) {
  return `${pair.session_id}\0${pair.image_id.toLowerCase()}`;
}

const importDownloadSchema = z.strictObject({ url: nonEmptyString });
export type ImportDownload = Readonly<z.infer<typeof importDownloadSchema>>;

const preparedSchema = z.strictObject({
  prepared_image_path: nonEmptyString,
  prepared_thumbnail_path: nonEmptyString,
  original_size: positiveInteger,
  original_width: positiveInteger,
  original_height: positiveInteger,
  width: positiveInteger,
  height: positiveInteger,
  ext: z.enum(["jpg", "png", "webp", "gif", "avif"]),
  md5: digest(16),
  prepared_image_sha256: digest(32),
  prepared_thumbnail_sha256: digest(32),
  size: positiveInteger,
  thumbnail_size: positiveInteger,
  quality: nonNegativeInteger.nullable(),
  transcoded: z.boolean(),
  detected_device: z.enum(["pc", "mb"]),
  detected_brightness: z.enum(["dark", "light"]),
  duplicate_count: nonNegativeInteger,
  generation: nonEmptyString
});
export type IngestionPreparedManifest = Readonly<z.infer<typeof preparedSchema>>;

const commitSchema = z.strictObject({
  commit_request_id: nonEmptyString,
  commit_intent_hash: digest(32),
  created_by: nonEmptyString,
  expected_md5: digest(16),
  duplicate_decision: duplicateDecision,
  metadata: draftSchema,
  final_object_key: nonEmptyString
});
const sessionErrorSchema = z.strictObject({ code: nonEmptyString, message: z.string() });
export type IngestionSessionError = Readonly<z.infer<typeof sessionErrorSchema>>;

const sessionShape = {
  ...pairShape,
  owner: nonEmptyString,
  queue: z.enum(ingestionQueueTypes),
  request_hash: digest(32),
  version: positiveInteger,
  last_semantic_revision: positiveInteger,
  accepted_at: nonNegativeInteger,
  accepted_order: positiveInteger,
  discard_at: positiveInteger
};

/** The recoverable Redis truth for an accepted but unfinished task. */
const activeSessionSchema = z.strictObject({
  ...sessionShape,
  source_type: z.enum(ingestionSourceTypes),
  batch_position: batchPosition.optional(),
  manifest_line: manifestLine.optional(),
  image_time: nonEmptyString,
  import_download: importDownloadSchema.optional(),
  metadata: draftSchema,
  storage_slug: nonEmptyString,
  status: z.enum(ingestionSessionStatuses).exclude(["completed", "discarded"]),
  phase: z.string(),
  message: z.string(),
  progress: z.number().min(0).max(100).nullable(),
  progress_seq: nonNegativeInteger,
  execution_token: z.string(),
  raw_generation: z.string(),
  raw_size: nonNegativeInteger,
  prepared: preparedSchema.optional(),
  duplicate_decision: duplicateDecision.optional(),
  commit: commitSchema.optional(),
  error: sessionErrorSchema.optional(),
  semantic_hash: digest(32)
}).superRefine((session, context) => {
  if ((session.queue === "upload") !== (session.source_type === "upload")) {
    context.addIssue({ code: "custom", path: ["source_type"], message: "Mismatched queue and source_type" });
  }
  if ((session.queue === "import") !== (session.import_download !== undefined)) {
    context.addIssue({ code: "custom", path: ["import_download"], message: "Import download must belong to an Import canonical" });
  }
});
export type IngestionSessionSnapshot = Readonly<z.infer<typeof activeSessionSchema>>;

const completedDisplaySchema = z.strictObject({
  source_type: z.enum(ingestionSourceTypes),
  batch_position: batchPosition.optional(),
  manifest_line: manifestLine.optional(),
  original_width: positiveInteger,
  original_height: positiveInteger,
  original_size: positiveInteger,
  quality: nonNegativeInteger.nullable(),
  transcoded: z.boolean()
});

export function completedIngestionDisplay(
  session: IngestionSessionSnapshot
): CompletedIngestionDisplayDto | undefined {
  if (!session.prepared) return undefined;
  return {
    source_type: session.source_type,
    ...(session.batch_position === undefined ? {} : { batch_position: session.batch_position }),
    ...(session.manifest_line === undefined ? {} : { manifest_line: session.manifest_line }),
    original_width: session.prepared.original_width,
    original_height: session.prepared.original_height,
    original_size: session.prepared.original_size,
    quality: session.prepared.quality,
    transcoded: session.prepared.transcoded
  };
}

const completedReceiptSchema = z.strictObject({
  ...sessionShape,
  commit_request_id: nonEmptyString,
  commit_intent_hash: digest(32),
  status: z.literal("completed"),
  completed_at: nonNegativeInteger,
  display: completedDisplaySchema.optional()
}).superRefine((session, context) => {
  if (session.display && ((session.queue === "upload") !== (session.display.source_type === "upload"))) {
    context.addIssue({ code: "custom", path: ["display", "source_type"], message: "Mismatched queue and display source_type" });
  }
});
export type CompletedIngestionReceipt = Readonly<z.infer<typeof completedReceiptSchema>>;

const discardedReceiptSchema = z.strictObject({
  ...sessionShape,
  image_time: nonEmptyString,
  status: z.literal("discarded"),
  discarded_at: nonNegativeInteger
});
export type DiscardedIngestionReceipt = Readonly<z.infer<typeof discardedReceiptSchema>>;

export const storedIngestionSessionSchema = z.discriminatedUnion("status", [
  activeSessionSchema, completedReceiptSchema, discardedReceiptSchema
]);
export type StoredIngestionSession = Readonly<z.infer<typeof storedIngestionSessionSchema>>;

export const uploadIntentSchema = z.strictObject({
  owner: nonEmptyString,
  session_id: nonEmptyString,
  candidate_image_id: nonEmptyString,
  resolved_image_time: nonEmptyString,
  request_hash: digest(32),
  display_order_key: z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{3}:[A-Za-z0-9_-]{43}$/u),
  batch_position: batchPosition,
  metadata: draftSchema,
  storage_slug: nonEmptyString,
  expected_size: positiveInteger,
  max_long_edge: positiveInteger,
  created_at: nonNegativeInteger,
  expires_at: positiveInteger,
  execution_token: z.string(),
  claim_heartbeat_at: nonNegativeInteger
}).refine((intent) => intent.display_order_key.endsWith(`:${intent.session_id}`), {
  path: ["display_order_key"], message: "Display order must identify the session"
});
export type UploadIntentSnapshot = Readonly<z.infer<typeof uploadIntentSchema>>;

export const ingestionQueueMetadataSchema = z.strictObject({
  owner: nonEmptyString,
  queue: z.enum(ingestionQueueTypes),
  revision: nonNegativeInteger,
  last_accepted_order: nonNegativeInteger,
  total: nonNegativeInteger,
  unfinished: nonNegativeInteger,
  waiting: nonNegativeInteger,
  running: nonNegativeInteger,
  ready: nonNegativeInteger,
  duplicate_pending: nonNegativeInteger,
  committing_resolving: nonNegativeInteger,
  resolving: nonNegativeInteger,
  completed: nonNegativeInteger,
  failed: nonNegativeInteger
}).superRefine((metadata, context) => {
  if (metadata.revision < metadata.last_accepted_order) {
    context.addIssue({ code: "custom", path: ["revision"], message: "Regressed queue clock" });
  }
  if (metadata.unfinished !== metadata.total - metadata.completed) {
    context.addIssue({ code: "custom", path: ["unfinished"], message: "Inconsistent unfinished count" });
  }
  for (const field of ["waiting", "running", "ready", "duplicate_pending", "committing_resolving", "resolving", "failed"] as const) {
    if (metadata[field] > metadata.unfinished) {
      context.addIssue({ code: "custom", path: [field], message: "Count exceeds unfinished" });
    }
  }
  if (metadata.resolving > metadata.committing_resolving) {
    context.addIssue({ code: "custom", path: ["resolving"], message: "Inconsistent resolving subset" });
  }
});
export type IngestionQueueMetadata = Readonly<z.infer<typeof ingestionQueueMetadataSchema>>;

export type IngestionQueueSnapshot = Readonly<{
  metadata: IngestionQueueMetadata;
  offset: number;
  limit: number;
  items: StoredIngestionSession[];
  staleItems: IngestionSessionPair[];
}>;
