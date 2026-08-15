import type { ImportJob } from "../../../lib/types.js";

export function importJobStatusDetail(
  job: ImportJob,
  hasQueueDuplicate = false
): string | null {
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
        job.duplicateDecision === "undecided"
        && (job.duplicates.length > 0 || hasQueueDuplicate)
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
    case "cancelled":
      return null;
  }
}
