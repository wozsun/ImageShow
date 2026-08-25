import type { ImportJob } from "../../../lib/types.js";
import { importJobNeedsDuplicateConfirmation } from "./duplicate-match.js";

const statusLabels: Record<ImportJob["status"], string> = {
  queued: "等待中",
  uploading: "上传中",
  downloading: "下载中",
  received: "待处理",
  processing: "处理中",
  ready: "已就绪",
  "commit-queued": "提交排队",
  committing: "提交中",
  finalized: "已写入",
  cancelling: "取消中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

export function importJobStatusLabel(job: ImportJob) {
  if (job.failureStage === "cancel") return "取消失败";
  if (
    importJobNeedsDuplicateConfirmation(job)
    && (job.duplicateCount ?? 0) > 0
  ) {
    return "待确认";
  }
  return statusLabels[job.status];
}

export function importJobStatusDetail(job: ImportJob): string | null {
  if (job.failureStage === "cancel") {
    return job.message || "取消失败";
  }
  if (job.status === "failed") {
    return job.message || "导入处理失败";
  }

  switch (job.status) {
    case "queued":
      return job.kind === "local" ? "等待上传" : "等待下载";
    case "uploading":
      return "上传原图中";
    case "downloading":
      return "下载原图中";
    case "received":
      return job.serverPhase === "prepare-waiting"
        ? "原图素材已接收，等待处理"
        : "处理图片并生成缩略图";
    case "processing":
      return "处理图片并生成缩略图";
    case "ready":
      if (job.duplicateDecision === "confirmed") return "已确认保留副本";
      if (
        importJobNeedsDuplicateConfirmation(job)
        && (job.duplicateCount ?? 0) > 0
      ) {
        return "发现重复图片，请确认";
      }
      return "图片处理完成，等待提交";
    case "commit-queued":
      return "等待提交";
    case "committing":
      return job.resultState === "recovering"
        ? "正在确认提交结果"
        : "写入图库中";
    case "finalized":
      if (job.resultState === "recovering") return "正在确认提交结果";
      if (job.resultState === "error") {
        return job.message || "已写入图库，但结果读取失败";
      }
      return "已写入图库，等待结果";
    case "cancelling":
      return "正在取消并清理暂存数据";
    case "done":
      return "图片已入库";
    case "cancelled":
      return null;
  }
}
