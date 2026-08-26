import type {
  CompletedIngestionDisplayDto,
  ActiveServerIngestionItemDto,
  IngestionSessionPairDto,
  IngestionStatusItemDto
} from "@imageshow/shared/browser";
import { ingestionPreviewPath } from "@imageshow/shared/browser";
import { ApiError } from "../../../core/api-error.ts";
import { privateNoStoreCacheControl } from "../../../core/http/headers.ts";
import { contentType } from "../../../storage/objects/keys.ts";
import { readStorageBuffer } from "../../../storage/objects/access.ts";
import { withStorageLocationReadLock } from "../../../storage/maintenance-lock.ts";
import {
  committedIngestionResultForOwner,
  readCommittedIngestionResultsByImageIds
} from "../../read-models/ingestion-results.ts";
import {
  completedIngestionDisplay,
  type CompletedIngestionReceipt,
  type IngestionSessionSnapshot
} from "../sessions/model.ts";
import {
  ingestionSessionIncarnationMismatch,
  IngestionSessionRepository
} from "../repository.ts";

function previewPath(
  session: Pick<IngestionSessionSnapshot, "session_id" | "image_id">,
  full = false
) {
  return `${ingestionPreviewPath}/${encodeURIComponent(
    session.session_id
  )}/${encodeURIComponent(session.image_id)}${full ? "/full" : ""}`;
}

export function presentIngestionSession(
  session: IngestionSessionSnapshot
): ActiveServerIngestionItemDto {
  const prepared = session.prepared
    ? {
        preview_url: previewPath(session),
        preview_full_url: previewPath(session, true),
        width: session.prepared.width,
        height: session.prepared.height,
        original_width: session.prepared.original_width,
        original_height: session.prepared.original_height,
        md5: session.prepared.md5,
        original_size: session.prepared.original_size,
        size: session.prepared.size,
        quality: session.prepared.quality,
        transcoded: session.prepared.transcoded,
        detected_device: session.prepared.detected_device,
        detected_brightness: session.prepared.detected_brightness,
        storage_slug: session.storage_slug,
        duplicate_count: session.prepared.duplicate_count
      }
    : undefined;
  return {
    session_id: session.session_id,
    image_id: session.image_id,
    queue: session.queue,
    source_type: session.source_type,
    ...(session.import_source
      ? { source_url: session.import_source.url }
      : {}),
    ...(session.manifest_position === undefined
      ? {}
      : { manifest_position: session.manifest_position }),
    ...(session.manifest_line === undefined
      ? {}
      : { manifest_line: session.manifest_line }),
    resolved_image_time: session.image_time,
    status: session.status,
    phase: session.phase,
    message: session.message,
    ...(session.progress === null ? {} : { progress: session.progress }),
    version: session.version,
    progress_seq: session.progress_seq,
    last_semantic_revision: session.last_semantic_revision,
    accepted_at: session.accepted_at,
    accepted_order: session.accepted_order,
    metadata: session.metadata,
    storage_slug: session.storage_slug,
    ...(prepared ? { prepared } : {}),
    ...(session.duplicate_decision
      ? { duplicate_decision: session.duplicate_decision }
      : {}),
    ...(session.commit ? {
      commit: {
        commit_request_id: session.commit.commit_request_id,
        expected_md5: session.commit.expected_md5,
        duplicate_decision: session.commit.duplicate_decision,
        metadata: session.commit.metadata
      }
    } : {}),
    ...(session.error ? { error: session.error } : {})
  };
}

function completedDisplayForStoredSession(
  session: IngestionSessionSnapshot | CompletedIngestionReceipt | null
): CompletedIngestionDisplayDto | undefined {
  if (!session) return undefined;
  return session.status === "completed"
    ? session.display
    : completedIngestionDisplay(session);
}

export async function readIngestionStatuses(
  repository: IngestionSessionRepository,
  owner: string,
  pairs: readonly IngestionSessionPairDto[]
): Promise<IngestionStatusItemDto[]> {
  // A completed Redis receipt is only published after the PostgreSQL
  // transaction commits. Read Redis first so a receipt observed here has a
  // happens-before edge to the following PG lookup; starting both reads in
  // parallel could observe PG before commit and Redis after publication, then
  // incorrectly delete the valid receipt as stale.
  const sessions = await repository.readSessions(owner, pairs);
  const committed = await readCommittedIngestionResultsByImageIds(
    pairs.map((pair) => pair.image_id)
  );
  const results: IngestionStatusItemDto[] = [];
  for (const [index, pair] of pairs.entries()) {
    const stored = sessions[index];
    const databaseResult = committedIngestionResultForOwner(
      committed,
      pair.image_id,
      owner
    );
    if (databaseResult) {
      const redisSession = stored
        && stored !== ingestionSessionIncarnationMismatch
        && stored.image_id.toLowerCase() === pair.image_id.toLowerCase()
        && stored.status !== "discarded"
        ? stored
        : null;
      const display = completedDisplayForStoredSession(redisSession);
      results.push({
        ...pair,
        status: "completed",
        completed_item: databaseResult.item,
        ...(display ? { display } : {}),
        redis_status: redisSession?.status === "completed"
          ? "completed"
          : redisSession ? "active" : "missing",
        ...(redisSession ? {
          redis_version: redisSession.version,
          redis_last_semantic_revision:
            redisSession.last_semantic_revision
        } : {})
      });
      continue;
    }
    if (
      !stored
      || stored === ingestionSessionIncarnationMismatch
      || stored.status === "discarded"
    ) {
      results.push({ ...pair, status: "missing" });
      continue;
    }
    if (stored.status === "completed") {
      await repository.deleteSession(stored, stored.version);
      results.push({ ...pair, status: "missing" });
      continue;
    }
    results.push({
      ...pair,
      status: "present",
      item: presentIngestionSession(stored)
    });
  }
  return results;
}

async function preparedSession(
  repository: IngestionSessionRepository,
  owner: string,
  pair: IngestionSessionPairDto
) {
  const stored = await repository.readSession(owner, pair.session_id);
  if (
    !stored
    || stored.image_id !== pair.image_id
    || stored.status === "completed"
    || stored.status === "discarded"
    || !stored.prepared
  ) {
    throw new ApiError(404, "not_found", "准备好的图片不存在");
  }
  return stored as IngestionSessionSnapshot;
}

export async function readIngestionPreview(
  repository: IngestionSessionRepository,
  owner: string,
  pair: IngestionSessionPairDto,
  variant: "thumb" | "full",
  requestSignal?: AbortSignal
) {
  const session = await preparedSession(repository, owner, pair);
  return withStorageLocationReadLock(async (lockSignal) => {
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, lockSignal])
      : lockSignal;
    signal.throwIfAborted();
    const current = await preparedSession(repository, owner, pair);
    if (
      current.version !== session.version
      || current.prepared?.generation !== session.prepared?.generation
    ) {
      throw new ApiError(409, "ingestion_version_conflict", "内容接入任务版本已变化");
    }
    const key = variant === "full"
      ? current.prepared!.prepared_image_key
      : current.prepared!.prepared_thumbnail_key;
    const buffer = await readStorageBuffer(
      "_uploads",
      key,
      current.storage_slug,
      { signal }
    );
    return new Response(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": variant === "full"
          ? contentType(current.prepared!.ext)
          : "image/webp",
        "Cache-Control": privateNoStoreCacheControl
      }
    });
  });
}
