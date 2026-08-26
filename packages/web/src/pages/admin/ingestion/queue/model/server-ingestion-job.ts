import type {
  AdminImageListItemDto,
  ActiveServerIngestionItemDto,
  CompletedIngestionDisplayDto,
  CompletedServerIngestionItemDto,
  IngestionStatusItemDto,
  ServerIngestionItemDto
} from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../../lib/types.js";
import {
  classificationOverrideFor,
  draftWithDetectedClassification
} from "./ingestion-attribute-policy.js";
import { ingestionDuplicateMessage } from "./duplicate-match.js";

export function serverIngestionPairKey(
  pair: Pick<ServerIngestionItemDto, "session_id" | "image_id">
) {
  return `${pair.session_id}\0${pair.image_id.toLowerCase()}`;
}

export function ingestionJobHasServerAuthority(job: IngestionJob) {
  // A successful intent/accept response is the ownership boundary. The
  // accepted order is useful for an exact response-first total, but authority
  // must not depend on the later bounded snapshot adopting the pair.
  return job.serverAccepted === true;
}

export function ingestionJobAwaitsActionCoverage(
  job: IngestionJob,
  serverRevision: number | null
) {
  if (
    !ingestionJobHasServerAuthority(job)
    || job.serverHandoffPending !== true
  ) return false;
  // This is deliberately independent of the canonical DTO revision/order: an
  // older DTO may already exist when a newer accept or completion replay HTTP
  // response arrives. Unknown completion revisions require a fresh snapshot.
  return job.serverHandoffRevision === undefined
    || serverRevision === null
    || job.serverHandoffRevision > serverRevision;
}

export function serverIngestionJobPairKey(job: IngestionJob) {
  return job.sessionId && job.imageId
    ? serverIngestionPairKey({
        session_id: job.sessionId,
        image_id: job.imageId
      })
    : "";
}

export function ingestionHandoffRetryDecision(
  requestRevision: number | null,
  currentRevision: number | null,
  observedSemanticRevision?: number
) {
  const retryAfterRevision = Math.max(
    requestRevision ?? 0,
    observedSemanticRevision ?? 0
  );
  return {
    retryAfterRevision,
    retryImmediately: currentRevision !== null
      && currentRevision > retryAfterRevision
  };
}

export function serverIngestionJobsForCombinedPage(
  jobs: readonly IngestionJob[],
  items: readonly Pick<ServerIngestionItemDto, "session_id" | "image_id">[],
  limit: number,
  visibleHandoffPairs: ReadonlySet<string> = new Set()
) {
  if (limit <= 0) return [];
  const jobsByPair = new Map(
    jobs.map((job) => [serverIngestionJobPairKey(job), job])
  );
  const snapshotPairs = new Set(items.map(serverIngestionPairKey));
  const seen = new Set<string>();
  const result: IngestionJob[] = [];
  for (const job of jobs) {
    const pairKey = serverIngestionJobPairKey(job);
    if (
      !pairKey
      || !visibleHandoffPairs.has(pairKey)
      || snapshotPairs.has(pairKey)
      || seen.has(pairKey)
    ) continue;
    seen.add(pairKey);
    result.push(job);
  }
  for (const item of items) {
    const pairKey = serverIngestionPairKey(item);
    const job = jobsByPair.get(pairKey);
    if (!job || seen.has(pairKey)) continue;
    seen.add(pairKey);
    result.push(job);
  }
  return result.slice(0, limit);
}

function activeClientStatus(
  item: ActiveServerIngestionItemDto
): IngestionJob["status"] {
  switch (item.status) {
    case "queued": return "queued";
    case "downloading": return "downloading";
    case "received": return "received";
    case "preparing": return "processing";
    case "ready": return "ready";
    case "committing": return "committing";
    case "resolving": return "finalized";
    case "failed": return "failed";
  }
}

function activeIngestionJob(
  item: ActiveServerIngestionItemDto,
  existing?: IngestionJob,
  serverRevision?: number | null
): IngestionJob {
  const pairKey = serverIngestionPairKey(item);
  const prepared = item.prepared;
  const detected = prepared ? {
    device: prepared.detected_device,
    brightness: prepared.detected_brightness
  } : undefined;
  const canonicalDraft = detected
    ? draftWithDetectedClassification(item.metadata, detected)
    : item.metadata;
  const draft = existing?.serverDraftPending
    ? existing.draft
    : canonicalDraft;
  const semanticPending = existing?.serverDraftPending === true;
  const serverVersion = semanticPending && existing?.serverVersion !== undefined
    ? Math.max(item.version, existing.serverVersion)
    : item.version;
  const serverSemanticRevision = semanticPending
    && existing?.serverSemanticRevision !== undefined
    ? Math.max(item.last_semantic_revision, existing.serverSemanticRevision)
    : item.last_semantic_revision;
  const duplicateCount = semanticPending
    ? existing.duplicateCount ?? prepared?.duplicate_count ?? 0
    : prepared?.duplicate_count ?? 0;
  const duplicateDecision: IngestionJob["duplicateDecision"] =
    semanticPending && existing
      ? existing.duplicateDecision
      : item.duplicate_decision === "confirmed"
      ? "confirmed"
      : item.duplicate_decision === "upload"
        ? "upload"
        : duplicateCount > 0 ? "undecided" : "upload";
  const failed = item.status === "failed";
  const commitIntent = item.commit ? {
    attemptId: item.commit.commit_request_id,
    md5: item.commit.expected_md5,
    metadata: item.commit.metadata
  } : undefined;
  const handoffPending = existing?.serverHandoffPending === true && (
    existing.serverHandoffRevision === undefined
    || serverRevision === undefined
    || serverRevision === null
    || serverRevision < existing.serverHandoffRevision
  );
  const manifestSource = item.source_type === "weibo"
    || item.source_type === "jsonl"
    ? item.source_type
    : undefined;
  return {
    id: existing?.id ?? `server:${pairKey}`,
    attemptKey: existing?.attemptKey ?? pairKey,
    subscriptionBatchKey: existing?.subscriptionBatchKey ?? pairKey,
    kind: item.queue,
    status: activeClientStatus(item),
    message: item.status === "ready"
      ? semanticPending && existing
        ? existing.message
        : duplicateDecision === "confirmed"
        ? "已确认提交副本"
        : ingestionDuplicateMessage(duplicateCount)
      : item.error?.message || item.message,
    preview: prepared?.preview_url ?? existing?.preview ?? "",
    previewFull: prepared?.preview_full_url ?? existing?.previewFull,
    objectUrl: prepared ? undefined : existing?.objectUrl,
    draft,
    width: prepared?.width ?? existing?.width ?? 0,
    height: prepared?.height ?? existing?.height ?? 0,
    originalWidth: prepared?.original_width ?? existing?.originalWidth,
    originalHeight: prepared?.original_height ?? existing?.originalHeight,
    transferProgress: item.progress,
    duplicates: existing?.duplicates ?? [],
    duplicateCount,
    duplicateDecision,
    ...(detected ? {
      detectedClassification: detected,
      classificationOverride: classificationOverrideFor(draft, detected)
    } : {}),
    file: existing?.file,
    fileFingerprint: existing?.fileFingerprint,
    md5: prepared?.md5 ?? existing?.md5,
    preparedOrder: existing?.preparedOrder,
    url: item.source_url ?? existing?.url,
    uploadIntentInput: existing?.uploadIntentInput,
    importAcceptInput: existing?.importAcceptInput,
    serverAccepted: true,
    serverDraftPending: existing?.serverDraftPending,
    sessionId: item.session_id,
    imageId: item.image_id,
    serverVersion,
    serverProgressSeq: item.progress_seq,
    serverSemanticRevision,
    serverHandoffPending: handoffPending,
    serverHandoffRevision: handoffPending
      ? existing?.serverHandoffRevision
      : undefined,
    serverAcceptedOrder: item.accepted_order,
    imageTime: item.resolved_image_time,
    batchTime: existing?.batchTime,
    manifestSource: manifestSource ?? existing?.manifestSource,
    manifestProvidedCommonFields: existing?.manifestProvidedCommonFields,
    manifestLine: item.manifest_line ?? existing?.manifestLine,
    manifestPosition: item.manifest_position ?? existing?.manifestPosition,
    browserDisplayReleased: existing
      ? existing.browserDisplayReleased
      : true,
    originalSize: prepared?.original_size ?? existing?.originalSize,
    finalSize: prepared?.size ?? existing?.finalSize,
    quality: prepared ? prepared.quality : existing?.quality,
    transcoded: prepared?.transcoded ?? existing?.transcoded,
    storageSlug: item.storage_slug,
    failureStage: failed ? item.commit ? "commit" : "prepare" : undefined,
    commitFailureCheckpoint: failed && item.commit ? "committing" : undefined,
    commitIntent,
    resultState: item.status === "committing" || item.status === "resolving"
      ? "pending"
      : undefined,
    resultError: undefined,
    serverStatus: item.status,
    serverPhase: item.phase,
    serverError: item.error?.message ?? "",
    serverProgress: item.progress,
    serverAttemptKey: existing?.attemptKey ?? pairKey,
    serverSessionId: item.session_id,
    serverImageId: item.image_id
  };
}

function completedIngestionJob(
  item: CompletedServerIngestionItemDto,
  existing?: IngestionJob
): IngestionJob {
  const pairKey = serverIngestionPairKey(item);
  const completed = item.completed_item;
  return {
    id: existing?.id ?? `server:${pairKey}`,
    attemptKey: existing?.attemptKey ?? pairKey,
    subscriptionBatchKey: existing?.subscriptionBatchKey ?? pairKey,
    kind: item.queue,
    originalWidth: existing?.originalWidth,
    originalHeight: existing?.originalHeight,
    originalSize: existing?.originalSize ?? existing?.file?.size,
    quality: existing?.quality,
    transcoded: existing?.transcoded,
    file: existing?.file,
    fileFingerprint: existing?.fileFingerprint,
    url: existing?.url,
    batchTime: existing?.batchTime,
    manifestSource: existing?.manifestSource,
    manifestProvidedCommonFields: existing?.manifestProvidedCommonFields,
    manifestLine: existing?.manifestLine,
    manifestPosition: existing?.manifestPosition,
    browserDisplayReleased: existing
      ? existing.browserDisplayReleased
      : true,
    ...completedIngestionJobPatch(completed, item.display),
    duplicates: [],
    duplicateDecision: "upload",
    serverAccepted: true,
    sessionId: item.session_id,
    imageId: item.image_id,
    serverVersion: item.version,
    serverProgressSeq: 0,
    serverSemanticRevision: item.last_semantic_revision,
    serverHandoffPending: false,
    serverHandoffRevision: undefined,
    serverAcceptedOrder: item.accepted_order,
    serverAttemptKey: existing?.attemptKey ?? pairKey,
    serverSessionId: item.session_id,
    serverImageId: item.image_id
  };
}

export function completedIngestionJobPatch(
  completed: AdminImageListItemDto,
  display?: CompletedIngestionDisplayDto
) {
  const manifestSource = display?.source_type === "weibo"
    || display?.source_type === "jsonl"
    ? display.source_type
    : undefined;
  return {
    status: "done",
    message: "已完成",
    preview: completed.thumb_url,
    previewFull: completed.object_url,
    objectUrl: undefined,
    draft: {
      device: completed.device,
      brightness: completed.brightness,
      theme: completed.theme,
      author: completed.author,
      title: completed.title,
      description: completed.description,
      source: completed.source,
      original: completed.original,
      tags: completed.tags
    },
    width: completed.width,
    height: completed.height,
    ...(display ? {
      originalWidth: display.original_width,
      originalHeight: display.original_height,
      originalSize: display.original_size,
      quality: display.quality,
      transcoded: display.transcoded,
      ...(manifestSource ? { manifestSource } : {}),
      ...(display.manifest_line === undefined
        ? {}
        : { manifestLine: display.manifest_line }),
      ...(display.manifest_position === undefined
        ? {}
        : { manifestPosition: display.manifest_position })
    } : {}),
    finalSize: completed.image_size,
    md5: completed.md5,
    imageTime: completed.image_time,
    storageSlug: completed.storage_slug,
    failureStage: undefined,
    commitFailureCheckpoint: undefined,
    resultState: "hydrated",
    resultError: undefined,
    serverStatus: "completed",
    serverError: "",
    serverProgress: undefined
  } satisfies Partial<IngestionJob>;
}

export function ingestionJobFromServerItem(
  item: ServerIngestionItemDto,
  existing?: IngestionJob,
  serverRevision?: number | null
) {
  return item.status === "completed"
    ? completedIngestionJob(item, existing)
    : activeIngestionJob(item, existing, serverRevision);
}

function ingestionJobFromKnownCompletedResult(
  existing: IngestionJob,
  completed: AdminImageListItemDto,
  display?: CompletedIngestionDisplayDto
): IngestionJob {
  if (existing.objectUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(existing.objectUrl);
  }
  return {
    ...existing,
    originalSize: existing.originalSize ?? existing.file?.size,
    ...completedIngestionJobPatch(completed, display),
    serverAccepted: false,
    serverHandoffPending: false,
    serverHandoffRevision: undefined,
    serverAttemptKey: existing.attemptKey,
    serverSessionId: existing.sessionId,
    serverImageId: existing.imageId
  };
}

export function ingestionJobFromKnownCompletedStatus(
  existing: IngestionJob,
  status: Extract<IngestionStatusItemDto, { status: "completed" }>
) {
  return status.redis_status !== "missing"
    ? null
    : ingestionJobFromKnownCompletedResult(
        existing,
        status.completed_item,
        status.display
      );
}
