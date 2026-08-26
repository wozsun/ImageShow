import {
  ingestionQueueTypes,
  ingestionSessionStatuses,
  ingestionSourceTypes,
  type IngestionQueueMetadata,
  type StoredIngestionSession,
  type UploadIntentSnapshot
} from "./model.ts";

function record(value: unknown, context: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Redis import ${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Redis import value has invalid ${field}`);
  }
  return value;
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new Error(`Redis import value has invalid ${field}`);
  }
  return value;
}

function booleanValue(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new Error(`Redis import value has invalid ${field}`);
  }
  return value;
}

function enumValue(
  value: unknown,
  allowed: readonly string[],
  field: string
) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Redis import value has invalid ${field}`);
  }
  return value;
}

function digestValue(value: unknown, bytes: number, field: string) {
  const digest = nonEmptyString(value, field);
  if (!new RegExp(`^[a-f0-9]{${bytes * 2}}$`, "u").test(digest)) {
    throw new Error(`Redis import value has invalid ${field}`);
  }
  return digest;
}

function displayOrderKey(value: unknown, sessionId: string) {
  const key = nonEmptyString(value, "display_order_key");
  if (
    !/^[0-9a-f]{32}:[0-9a-f]{3}:[A-Za-z0-9_-]{43}$/u.test(key)
    || !key.endsWith(`:${sessionId}`)
  ) {
    throw new Error("Redis import value has invalid display_order_key");
  }
  return key;
}

function nonNegativeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Redis import value has invalid ${field}`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, field: string) {
  const parsed = nonNegativeInteger(value, field);
  if (parsed < 1) throw new Error(`Redis import value has invalid ${field}`);
  return parsed;
}

function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((field, index) => field !== required[index])
  ) {
    throw new Error(`Redis import ${context} contains unexpected fields`);
  }
}

function allowedFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  context: string
) {
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((field) => !allowed.has(field))
    || required.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error(`Redis import ${context} contains unexpected fields`);
  }
}

const draftFields = [
  "device",
  "brightness",
  "theme",
  "author",
  "title",
  "description",
  "source",
  "original",
  "tags"
] as const;

function parseDraft(value: unknown, context: string) {
  const draft = record(value, context);
  exactFields(draft, draftFields, context);
  enumValue(draft.device, ["pc", "mb", "auto"], `${context}.device`);
  enumValue(
    draft.brightness,
    ["dark", "light", "auto"],
    `${context}.brightness`
  );
  for (const field of [
    "theme",
    "author",
    "title",
    "description",
    "source",
    "original"
  ] as const) stringValue(draft[field], `${context}.${field}`);
  if (
    !Array.isArray(draft.tags)
    || draft.tags.some((tag) => typeof tag !== "string")
  ) throw new Error(`Redis import value has invalid ${context}.tags`);
}

function parseImportDescription(value: unknown) {
  const remote = record(value, "remote description");
  exactFields(remote, ["url"], "remote description");
  nonEmptyString(remote.url, "remote.url");
}

function parsePrepared(value: unknown) {
  const prepared = record(value, "prepared manifest");
  exactFields(prepared, [
    "prepared_image_key",
    "prepared_thumbnail_key",
    "original_size",
    "original_width",
    "original_height",
    "width",
    "height",
    "ext",
    "md5",
    "prepared_image_sha256",
    "prepared_thumbnail_sha256",
    "size",
    "thumbnail_size",
    "quality",
    "transcoded",
    "detected_device",
    "detected_brightness",
    "duplicate_count",
    "generation"
  ], "prepared manifest");
  nonEmptyString(prepared.prepared_image_key, "prepared.prepared_image_key");
  nonEmptyString(
    prepared.prepared_thumbnail_key,
    "prepared.prepared_thumbnail_key"
  );
  for (const field of [
    "original_size",
    "original_width",
    "original_height",
    "width",
    "height",
    "size",
    "thumbnail_size"
  ] as const) positiveInteger(prepared[field], `prepared.${field}`);
  nonNegativeInteger(prepared.duplicate_count, "prepared.duplicate_count");
  enumValue(prepared.ext, ["jpg", "png", "webp", "gif", "avif"], "prepared.ext");
  digestValue(prepared.md5, 16, "prepared.md5");
  if (
    prepared.quality !== null
    && (!Number.isSafeInteger(prepared.quality) || Number(prepared.quality) < 0)
  ) throw new Error("Redis import value has invalid prepared.quality");
  booleanValue(prepared.transcoded, "prepared.transcoded");
  enumValue(prepared.detected_device, ["pc", "mb"], "prepared.detected_device");
  enumValue(
    prepared.detected_brightness,
    ["dark", "light"],
    "prepared.detected_brightness"
  );
  nonEmptyString(prepared.generation, "prepared.generation");
  digestValue(
    prepared.prepared_image_sha256,
    32,
    "prepared.prepared_image_sha256"
  );
  digestValue(
    prepared.prepared_thumbnail_sha256,
    32,
    "prepared.prepared_thumbnail_sha256"
  );
}

function parseCompletedDisplay(value: unknown, queue: unknown) {
  const display = record(value, "completed display");
  allowedFields(display, [
    "source_type",
    "original_width",
    "original_height",
    "original_size",
    "quality",
    "transcoded"
  ], [
    "manifest_position",
    "manifest_line"
  ], "completed display");
  enumValue(display.source_type, ingestionSourceTypes, "display.source_type");
  if (
    (queue === "upload" && display.source_type !== "upload")
    || (queue === "import" && display.source_type === "upload")
  ) {
    throw new Error("Redis import completed display has mismatched source_type");
  }
  for (const field of [
    "original_width",
    "original_height",
    "original_size"
  ] as const) positiveInteger(display[field], `display.${field}`);
  if (
    display.quality !== null
    && (!Number.isSafeInteger(display.quality) || Number(display.quality) < 0)
  ) throw new Error("Redis import value has invalid display.quality");
  booleanValue(display.transcoded, "display.transcoded");
  if (
    display.manifest_position !== undefined
    && (
      !Number.isSafeInteger(display.manifest_position)
      || Number(display.manifest_position) < 0
      || Number(display.manifest_position) > 0xfff
    )
  ) throw new Error("Redis import value has invalid display.manifest_position");
  if (display.manifest_line !== undefined) {
    const line = positiveInteger(display.manifest_line, "display.manifest_line");
    if (line > 1_000_000) {
      throw new Error("Redis import value has invalid display.manifest_line");
    }
  }
}

function parseCommit(value: unknown) {
  const commit = record(value, "commit intent");
  exactFields(commit, [
    "commit_request_id",
    "commit_intent_hash",
    "created_by",
    "expected_md5",
    "duplicate_decision",
    "metadata",
    "final_object_key"
  ], "commit intent");
  nonEmptyString(commit.commit_request_id, "commit.commit_request_id");
  digestValue(commit.commit_intent_hash, 32, "commit.commit_intent_hash");
  nonEmptyString(commit.created_by, "commit.created_by");
  digestValue(commit.expected_md5, 16, "commit.expected_md5");
  enumValue(
    commit.duplicate_decision,
    ["upload", "confirmed"],
    "commit.duplicate_decision"
  );
  parseDraft(commit.metadata, "commit metadata");
  nonEmptyString(commit.final_object_key, "commit.final_object_key");
}

function parseSessionError(value: unknown) {
  const error = record(value, "session error");
  exactFields(error, ["code", "message"], "session error");
  nonEmptyString(error.code, "error.code");
  stringValue(error.message, "error.message");
}

export function parseStoredIngestionSession(raw: string): StoredIngestionSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Redis import canonical contains invalid JSON");
  }
  const value = record(parsed, "canonical");
  nonEmptyString(value.session_id, "session_id");
  nonEmptyString(value.image_id, "image_id");
  nonEmptyString(value.owner, "owner");
  if (!ingestionQueueTypes.includes(value.queue as never)) {
    throw new Error("Redis import value has invalid queue");
  }
  if (!ingestionSessionStatuses.includes(value.status as never)) {
    throw new Error("Redis import value has invalid status");
  }
  digestValue(value.request_hash, 32, "request_hash");
  positiveInteger(value.version, "version");
  positiveInteger(value.last_semantic_revision, "last_semantic_revision");
  nonNegativeInteger(value.accepted_at, "accepted_at");
  positiveInteger(value.accepted_order, "accepted_order");
  positiveInteger(value.discard_at, "discard_at");
  if (value.status === "discarded") {
    exactFields(value, [
      "owner",
      "queue",
      "session_id",
      "image_id",
      "image_time",
      "request_hash",
      "status",
      "version",
      "last_semantic_revision",
      "accepted_at",
      "accepted_order",
      "discarded_at",
      "discard_at"
    ], "discarded receipt");
    nonEmptyString(value.image_time, "image_time");
    nonNegativeInteger(value.discarded_at, "discarded_at");
  } else if (value.status === "completed") {
    allowedFields(value, [
      "owner",
      "queue",
      "session_id",
      "image_id",
      "request_hash",
      "commit_request_id",
      "commit_intent_hash",
      "status",
      "version",
      "last_semantic_revision",
      "accepted_at",
      "accepted_order",
      "completed_at",
      "discard_at"
    ], ["display"], "completed receipt");
    nonNegativeInteger(value.completed_at, "completed_at");
    nonEmptyString(value.commit_request_id, "commit_request_id");
    digestValue(value.commit_intent_hash, 32, "commit_intent_hash");
    if (value.display !== undefined) {
      parseCompletedDisplay(value.display, value.queue);
    }
  } else {
    allowedFields(value, [
      "owner",
      "queue",
      "source_type",
      "session_id",
      "image_id",
      "image_time",
      "request_hash",
      "metadata",
      "storage_slug",
      "status",
      "phase",
      "message",
      "progress",
      "version",
      "progress_seq",
      "last_semantic_revision",
      "accepted_at",
      "accepted_order",
      "execution_token",
      "raw_generation",
      "raw_size",
      "discard_at",
      "semantic_hash"
    ], [
      "remote",
      "manifest_position",
      "manifest_line",
      "prepared",
      "duplicate_decision",
      "commit",
      "error"
    ], "active canonical");
    digestValue(value.semantic_hash, 32, "semantic_hash");
    nonNegativeInteger(value.progress_seq, "progress_seq");
    if (!ingestionSourceTypes.includes(value.source_type as never)) {
      throw new Error("Redis import value has invalid source_type");
    }
    if (
      (value.queue === "upload" && value.source_type !== "upload")
      || (value.queue === "import" && value.source_type === "upload")
    ) {
      throw new Error("Redis import value has mismatched queue and source_type");
    }
    nonEmptyString(value.image_time, "image_time");
    nonEmptyString(value.storage_slug, "storage_slug");
    stringValue(value.phase, "phase");
    stringValue(value.message, "message");
    stringValue(value.execution_token, "execution_token");
    stringValue(value.raw_generation, "raw_generation");
    nonNegativeInteger(value.raw_size, "raw_size");
    if (
      value.progress !== null
      && (
        typeof value.progress !== "number"
        || !Number.isFinite(value.progress)
        || value.progress < 0
        || value.progress > 100
      )
    ) throw new Error("Redis import value has invalid progress");
    parseDraft(value.metadata, "metadata");
    if (value.queue === "import") {
      parseImportDescription(value.remote);
    } else if (value.remote !== undefined) {
      throw new Error("Redis import upload canonical has remote description");
    }
    if (value.prepared !== undefined) parsePrepared(value.prepared);
    if (
      value.manifest_position !== undefined
      && (
        !Number.isSafeInteger(value.manifest_position)
        || Number(value.manifest_position) < 0
        || Number(value.manifest_position) > 0xfff
      )
    ) throw new Error("Redis import value has invalid manifest_position");
    if (value.manifest_line !== undefined) {
      const line = positiveInteger(value.manifest_line, "manifest_line");
      if (line > 1_000_000) {
        throw new Error("Redis import value has invalid manifest_line");
      }
    }
    if (value.duplicate_decision !== undefined) {
      enumValue(
        value.duplicate_decision,
        ["upload", "confirmed"],
        "duplicate_decision"
      );
    }
    if (value.commit !== undefined) parseCommit(value.commit);
    if (value.error !== undefined) parseSessionError(value.error);
  }
  return value as StoredIngestionSession;
}

export function parseUploadIntent(raw: string): UploadIntentSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Redis upload intent contains invalid JSON");
  }
  const value = record(parsed, "upload intent");
  exactFields(value, [
    "owner",
    "session_id",
    "candidate_image_id",
    "resolved_image_time",
    "request_hash",
    "display_order_key",
    "manifest_position",
    "metadata",
    "storage_slug",
    "expected_size",
    "max_long_edge",
    "created_at",
    "expires_at",
    "execution_token",
    "claim_heartbeat_at"
  ], "upload intent");
  nonEmptyString(value.owner, "owner");
  nonEmptyString(value.session_id, "session_id");
  nonEmptyString(value.candidate_image_id, "candidate_image_id");
  nonEmptyString(value.resolved_image_time, "resolved_image_time");
  digestValue(value.request_hash, 32, "request_hash");
  displayOrderKey(value.display_order_key, String(value.session_id));
  nonEmptyString(value.storage_slug, "storage_slug");
  stringValue(value.execution_token, "execution_token");
  positiveInteger(value.expected_size, "expected_size");
  positiveInteger(value.max_long_edge, "max_long_edge");
  nonNegativeInteger(value.created_at, "created_at");
  positiveInteger(value.expires_at, "expires_at");
  nonNegativeInteger(value.claim_heartbeat_at, "claim_heartbeat_at");
  parseDraft(value.metadata, "metadata");
  if (
    !Number.isSafeInteger(value.manifest_position)
    || Number(value.manifest_position) < 0
    || Number(value.manifest_position) > 0xfff
  ) throw new Error("Redis import value has invalid manifest_position");
  return value as UploadIntentSnapshot;
}

const metadataIntegerFields = [
  "revision",
  "last_accepted_order",
  "total",
  "unfinished",
  "waiting",
  "running",
  "ready",
  "duplicate_pending",
  "committing_resolving",
  "resolving",
  "completed",
  "failed"
] as const;

export function parseIngestionQueueMetadata(
  value: unknown
): IngestionQueueMetadata {
  const metadata = record(value, "queue metadata");
  exactFields(metadata, [
    "owner",
    "queue",
    ...metadataIntegerFields
  ], "queue metadata");
  nonEmptyString(metadata.owner, "owner");
  if (!ingestionQueueTypes.includes(metadata.queue as never)) {
    throw new Error("Redis import queue metadata has invalid queue");
  }
  for (const field of metadataIntegerFields) {
    nonNegativeInteger(metadata[field], field);
  }
  if (Number(metadata.revision) < Number(metadata.last_accepted_order)) {
    throw new Error("Redis import queue metadata has a regressed clock");
  }
  if (
    Number(metadata.unfinished)
      !== Number(metadata.total) - Number(metadata.completed)
  ) {
    throw new Error("Redis import queue metadata has inconsistent unfinished count");
  }
  for (const field of [
    "waiting",
    "running",
    "ready",
    "duplicate_pending",
    "committing_resolving",
    "resolving",
    "failed"
  ] as const) {
    if (Number(metadata[field]) > Number(metadata.unfinished)) {
      throw new Error(`Redis import queue metadata has inconsistent ${field} count`);
    }
  }
  if (
    Number(metadata.resolving) > Number(metadata.committing_resolving)
  ) {
    throw new Error(
      "Redis import queue metadata has inconsistent resolving subset"
    );
  }
  return metadata as unknown as IngestionQueueMetadata;
}

export function metadataFromHashReply(values: unknown[]) {
  if (values.length % 2 !== 0) {
    throw new Error("Redis import queue metadata has an invalid field count");
  }
  const metadata: Record<string, unknown> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (typeof key !== "string" || typeof value !== "string") {
      throw new Error("Redis import queue metadata contains invalid fields");
    }
    if (metadataIntegerFields.includes(key as never)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
        throw new Error("Redis import queue metadata contains invalid integer text");
      }
      const integer = Number(value);
      if (!Number.isSafeInteger(integer)) {
        throw new Error("Redis import queue metadata contains an unsafe integer");
      }
      metadata[key] = integer;
    } else {
      metadata[key] = value;
    }
  }
  return parseIngestionQueueMetadata(metadata);
}
