import type { RefObject } from "react";
import type { ImportJob } from "../../../lib/types.js";
import type { PreparedImport } from "./import-api.js";

export type ImportQueueApi = {
  jobsRef: RefObject<ImportJob[]>;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  claimPreparedMd5: (id: string, md5: string) => boolean;
};

export type AppendImportQueueApi = ImportQueueApi & {
  appendJobs: (jobs: ImportJob[]) => void;
};

export async function applyPreparedResult(queue: ImportQueueApi, jobId: string, prepared: PreparedImport) {
  // 先认领 md5：同一批并发完成的重复文件不会同时进入“待提交”状态。
  if (!queue.claimPreparedMd5(jobId, prepared.md5)) return false;
  const current = queue.jobsRef.current.find((job) => job.id === jobId);
  if (!current || current.status === "cancelled") return false;
  const duplicates = prepared.duplicates ?? [];
  const duplicateExists = prepared.duplicate_exists || duplicates.length > 0;
  // 服务端已提供稳定预览地址后，释放本地 blob URL，避免上传几十张大图时占用浏览器内存。
  if (current.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(current.objectUrl);
  queue.updateJob(jobId, {
    status: "ready",
    message: duplicateExists ? `发现 ${duplicates.length} 张相同图片` : "已就绪，待提交",
    preview: prepared.preview_url,
    previewFull: prepared.preview_url,
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
    detected: { device: prepared.device, brightness: prepared.brightness },
    duplicates,
    duplicateDecision: duplicateExists ? "undecided" : "upload",
    draft: {
      ...current.draft,
      device: current.draft.device || prepared.device,
      brightness: current.draft.brightness === "auto" ? prepared.brightness : current.draft.brightness || prepared.brightness
    }
  });
  return true;
}
