import { api } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import type { RefObject } from "react";
import type { ImageItem, ImportJob } from "../../../lib/types.js";
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
  // 先认领 md5 再查库：同一批并发完成的重复文件不会同时进入“待提交”状态。
  if (!queue.claimPreparedMd5(jobId, prepared.md5)) return false;
  queue.updateJob(jobId, { status: "processing", message: "检查重复图片" });
  const duplicate = await api<{ exists: boolean; items: ImageItem[] }>(`${adminApiBasePath}/images/check-md5`, {
    method: "POST",
    body: JSON.stringify({ md5: prepared.md5 })
  });
  const current = queue.jobsRef.current.find((job) => job.id === jobId);
  if (!current || current.status === "cancelled") return false;
  // 服务端已提供稳定预览地址后，释放本地 blob URL，避免上传几十张大图时占用浏览器内存。
  if (current.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(current.objectUrl);
  queue.updateJob(jobId, {
    status: "ready",
    message: duplicate.exists ? `发现 ${duplicate.items.length} 张相同图片` : "已就绪，待提交",
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
    duplicates: duplicate.items ?? [],
    duplicateDecision: duplicate.exists ? "undecided" : "upload",
    draft: {
      ...current.draft,
      device: current.draft.device || prepared.device,
      brightness: current.draft.brightness === "auto" ? prepared.brightness : current.draft.brightness || prepared.brightness
    }
  });
  return true;
}
