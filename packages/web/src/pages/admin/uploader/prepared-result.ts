import type { RefObject } from "react";
import type { ImportJob } from "../../../lib/types.js";
import type { PreparedImport } from "./import-api.js";
import type { PreparedMd5Claim } from "./duplicate-match.js";

export type ImportQueueApi = {
  jobsRef: RefObject<ImportJob[]>;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  claimPreparedMd5: (id: string, md5: string) => PreparedMd5Claim;
  releasePreparedMd5: (id: string) => boolean;
};

export type AppendImportQueueApi = ImportQueueApi & {
  appendJobs: (jobs: ImportJob[]) => void;
};

export type PreparedApplyResult =
  | { status: "applied" }
  | { status: "duplicate"; ownerId: string }
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
  // 先认领 md5：同一批并发完成的重复文件不会同时进入“待提交”状态。
  const claim = queue.claimPreparedMd5(jobId, prepared.md5);
  const duplicates = prepared.duplicates ?? [];
  const duplicateExists = duplicates.length > 0;
  // 服务端已提供稳定预览地址后，释放本地 blob URL，避免上传几十张大图时占用浏览器内存。
  if (current.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(current.objectUrl);
  const resolved = {
    device: prepared.device,
    brightness: prepared.brightness
  };
  queue.updateJob(jobId, {
    preview: prepared.preview_url,
    previewFull: prepared.preview_full_url,
    objectUrl: undefined,
    width: prepared.width,
    height: prepared.height,
    originalWidth: prepared.original_width,
    originalHeight: prepared.original_height,
    md5: prepared.md5,
    originalSize: prepared.original_size,
    finalSize: prepared.size,
    quality: prepared.quality,
    transcoded: prepared.transcoded,
    storageSlug: prepared.storage_slug,
    resolvedClassification: resolved,
    classificationOverride: undefined,
    duplicates,
    duplicateDecision: duplicateExists ? "undecided" : "upload",
    draft: {
      ...current.draft,
      device: current.draft.device === "auto" ? resolved.device : current.draft.device || resolved.device,
      brightness: current.draft.brightness === "auto" ? resolved.brightness : current.draft.brightness || resolved.brightness
    }
  });
  if (!claim.claimed) return { status: "duplicate", ownerId: claim.ownerId };
  let message = "已就绪，待提交";
  if (duplicateExists) {
    message = `发现 ${duplicates.length} 张相同图片`;
  }
  queue.updateJob(jobId, {
    status: "ready",
    message
  });
  return { status: "applied" };
}
