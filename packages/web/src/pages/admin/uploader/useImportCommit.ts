import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ImportJob } from "../../../lib/types.js";
import { normalizeAuthor, normalizeTheme, runWithConcurrency } from "../../../lib/upload/upload-utils.js";
import {
  commitStoredImport,
  getStoredImportStatus,
  type StoredImportCommitResult,
  type StoredImportStatus
} from "./import-api.js";
import { invalidateImageData } from "../../../lib/api/query-invalidation.js";
import { commitFailurePatchForStatus } from "./import-commit-state.js";

function normalizedCommitDraft(job: ImportJob) {
  return {
    ...job.draft,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author)
  };
}

function completedImportPatch(
  job: ImportJob,
  result: StoredImportCommitResult,
  importedMessage: string
): Partial<ImportJob> {
  return {
    status: "done",
    failureStage: undefined,
    commitFailureCheckpoint: undefined,
    message: result.status === "duplicate"
      ? "图片已存在（跳过）"
      : importedMessage,
    preview: result.item?.thumb_url ?? job.preview,
    previewFull: result.item?.object_url ?? job.previewFull ?? job.preview
  };
}

async function commitFailurePatch(
  job: ImportJob,
  error: unknown
): Promise<Partial<ImportJob>> {
  if (!job.sessionId) {
    return {
      status: "failed",
      failureStage: "prepare",
      commitFailureCheckpoint: undefined,
      message: "提交会话不存在，需要重新处理"
    };
  }

  let status: StoredImportStatus | undefined;
  try {
    status = await getStoredImportStatus(job.sessionId);
  } catch {
    status = undefined;
  }

  if (status?.status === "finalized") {
    try {
      const result = await commitStoredImport(
        job.sessionId,
        normalizedCommitDraft(job)
      );
      return completedImportPatch(job, result, "服务端已完成提交");
    } catch {
      // 状态查询已确认提交完成；补取最终展示地址失败不应把任务降级为失败。
    }
  }

  return commitFailurePatchForStatus(status, error);
}

export function useImportCommit(options: {
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  concurrency: number;
  onDone: () => void;
}) {
  const { updateJob, concurrency, onDone } = options;
  const client = useQueryClient();
  return useCallback(async (jobs: ImportJob[]) => {
    let imported = false;
    await runWithConcurrency(jobs, concurrency, async (job) => {
      try {
        updateJob(job.id, {
          status: "committing",
          failureStage: undefined,
          commitFailureCheckpoint: undefined,
          message: "写入图库"
        });
        if (!job.sessionId) throw new Error("导入会话不存在");
        const result = await commitStoredImport(
          job.sessionId,
          normalizedCommitDraft(job)
        );
        if (result.status === "imported") imported = true;
        updateJob(job.id, completedImportPatch(job, result, "已完成"));
      } catch (error) {
        const patch = await commitFailurePatch(job, error);
        if (patch.status === "done") imported = true;
        updateJob(job.id, patch);
      }
    });
    if (imported) await invalidateImageData(client);
    onDone();
  }, [client, concurrency, onDone, updateJob]);
}
