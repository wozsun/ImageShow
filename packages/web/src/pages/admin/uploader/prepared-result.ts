import type { RefObject } from "react";
import type { ImportJob } from "../../../lib/types.js";
import type { PreparedImport } from "./import-api.js";
import {
  classificationOverrideFor,
  draftWithDetectedClassification
} from "./import-attribute-policy.js";
import {
  importDuplicateMessage,
  preparedQueueDuplicateReference
} from "./duplicate-match.js";

export type ImportQueueApi = {
  jobsRef: RefObject<ImportJob[]>;
  committedMd5sRef: RefObject<ReadonlySet<string>>;
  deletedLibraryImageIdsRef: RefObject<ReadonlySet<string>>;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
};

export type AppendImportQueueApi = ImportQueueApi & {
  appendJobs: (jobs: ImportJob[]) => void;
};

export type PreparedApplyResult =
  | { status: "applied" }
  | { status: "stale" };

export function isCurrentImportAttempt(queue: ImportQueueApi, jobId: string, attemptKey: string) {
  const current = queue.jobsRef.current.find((job) => job.id === jobId);
  return Boolean(
    current
      && current.attemptKey === attemptKey
      && !["cancelling", "cancelled"].includes(current.status)
  );
}

export function applyPreparedResult(queue: ImportQueueApi, jobId: string, attemptKey: string, prepared: PreparedImport): PreparedApplyResult {
  const current = queue.jobsRef.current.find((job) => job.id === jobId);
  if (!current || ["cancelling", "cancelled"].includes(current.status) || current.attemptKey !== attemptKey || current.sessionId !== prepared.id) return { status: "stale" };
  const deletedLibraryImageIds = queue.deletedLibraryImageIdsRef.current;
  const duplicateItems = [
    ...(prepared.duplicates ?? []),
    ...current.duplicates.filter((item) => item.md5 === prepared.md5)
  ].filter((item) => !deletedLibraryImageIds.has(item.id));
  const duplicates = [
    ...new Map(duplicateItems.map((item) => [item.id, item])).values()
  ];
  const queueDuplicate = preparedQueueDuplicateReference(
    queue.jobsRef.current,
    jobId,
    prepared.md5
  );
  const duplicateExists = duplicates.length > 0 || Boolean(queueDuplicate);
  const preparedOrder = current.preparedOrder ?? queue.jobsRef.current.reduce(
    (highest, job) => Math.max(highest, job.preparedOrder ?? 0),
    0
  ) + 1;
  // 服务端已提供稳定预览地址后，释放本地 blob URL，避免上传几十张大图时占用浏览器内存。
  if (current.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(current.objectUrl);
  const detected = {
    device: prepared.detected_device,
    brightness: prepared.detected_brightness
  };
  const draft = draftWithDetectedClassification(current.draft, detected);
  queue.updateJob(jobId, {
    preview: prepared.preview_url,
    previewFallback: undefined,
    previewFull: prepared.preview_full_url,
    objectUrl: undefined,
    width: prepared.width,
    height: prepared.height,
    originalWidth: prepared.original_width,
    originalHeight: prepared.original_height,
    md5: prepared.md5,
    preparedOrder,
    originalSize: prepared.original_size,
    finalSize: prepared.size,
    quality: prepared.quality,
    transcoded: prepared.transcoded,
    storageSlug: prepared.storage_slug,
    detectedClassification: detected,
    classificationOverride: classificationOverrideFor(draft, detected),
    duplicates,
    duplicateDecision: duplicateExists ? "undecided" : "upload",
    draft,
    status: "ready",
    message: importDuplicateMessage(duplicates.length, queueDuplicate)
  });
  return { status: "applied" };
}
