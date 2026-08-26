import type { IngestionStatusItemDto } from "@imageshow/shared/browser";
import type { ImageDraft, IngestionJob } from "../../../../../lib/types.js";
import {
  ingestionJobFromServerItem,
  ingestionJobHasServerAuthority
} from "./server-ingestion-job.js";

export type DraftSyncTarget = Readonly<{
  id: string;
  attemptKey: string;
  sessionId: string;
  imageId: string;
  expectedVersion: number;
  draft: ImageDraft;
}>;

export type PendingDraftSync = {
  running: Promise<boolean> | null;
  dirty: boolean;
  retryable: boolean;
  target: DraftSyncTarget;
  awaitingRevision: number | null;
  awaitingConnectionGeneration: number | null;
};

export const draftSyncMutationAttempts = 8;

export function draftSyncTarget(job: IngestionJob): DraftSyncTarget | null {
  if (
    !ingestionJobHasServerAuthority(job)
    || !job.sessionId
    || !job.imageId
    || !job.serverVersion
    || job.commitIntent
    || ![
      "queued",
      "downloading",
      "received",
      "processing",
      "ready",
      "failed"
    ].includes(job.status)
  ) return null;
  return {
    id: job.id,
    attemptKey: job.attemptKey,
    sessionId: job.sessionId,
    imageId: job.imageId,
    expectedVersion: job.serverVersion,
    draft: job.draft
  };
}

export function matchesDraftTarget(
  job: IngestionJob,
  target: DraftSyncTarget
) {
  return job.id === target.id
    && job.attemptKey === target.attemptKey
    && job.sessionId === target.sessionId
    && job.imageId?.toLowerCase() === target.imageId.toLowerCase();
}

function completedDraft(
  item: Extract<IngestionStatusItemDto, { status: "completed" }>["completed_item"]
): ImageDraft {
  return {
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    author: item.author,
    title: item.title,
    description: item.description,
    source: item.source,
    original: item.original,
    tags: item.tags
  };
}

export function authoritativeDraftFromStatus(
  status: IngestionStatusItemDto | undefined
) {
  if (status?.status === "present") {
    return ingestionJobFromServerItem(status.item).draft;
  }
  return status?.status === "completed"
    ? completedDraft(status.completed_item)
    : undefined;
}
