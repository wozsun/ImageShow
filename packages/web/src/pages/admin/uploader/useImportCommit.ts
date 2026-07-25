import { useCallback } from "react";
import type { RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ImageItem, ImportJob } from "../../../lib/types.js";
import { normalizeAuthor, normalizeTheme, runWithConcurrency } from "../../../lib/upload/upload-utils.js";
import {
  commitStoredImport,
  getStoredImportStatus,
  type StoredImportCommitResult,
  type StoredImportStatus
} from "./import-api.js";
import { invalidateImageData } from "../../../lib/api/query-invalidation.js";
import {
  commitFailurePatchForStatus,
  resolveCommitRetry
} from "./import-status-state.js";
import {
  importJobCanStartCommit,
  type ImportCommitIntent
} from "./import-queue-state.js";

function normalizedCommitDraft(job: ImportJob) {
  return {
    ...job.draft,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author)
  };
}

type CompletedImport = {
  kind: "completed";
  patch: Partial<ImportJob>;
  item: ImageItem;
};

type FailedImport = {
  kind: "failed";
  patch: Partial<ImportJob>;
};

function completedImport(
  result: StoredImportCommitResult,
  importedMessage: string
): CompletedImport {
  return {
    kind: "completed",
    patch: {
      status: "done",
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
      message: importedMessage,
      preview: result.item.thumb_url,
      previewFull: result.item.object_url
    },
    item: result.item
  };
}

async function commitFailure(
  job: ImportJob,
  error: unknown
): Promise<CompletedImport | FailedImport> {
  if (!job.sessionId) {
    return {
      kind: "failed",
      patch: {
        status: "failed",
        failureStage: "prepare",
        commitFailureCheckpoint: undefined,
        message: "提交会话不存在，需要重新处理"
      }
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
      return completedImport(result, "服务端已完成提交");
    } catch (recoveryError) {
      return {
        kind: "failed",
        patch: commitFailurePatchForStatus(status, recoveryError)
      };
    }
  }

  return {
    kind: "failed",
    patch: commitFailurePatchForStatus(status, error)
  };
}

export function useImportCommit(options: {
  jobsRef: RefObject<ImportJob[]>;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  completeJob: (id: string, patch: Partial<ImportJob>, item: ImageItem) => void;
  concurrency: number;
  onDone: () => void;
}) {
  const {
    jobsRef,
    updateJob,
    completeJob,
    concurrency,
    onDone
  } = options;
  const client = useQueryClient();
  return useCallback(async (jobs: ImportJob[]) => {
    let imported = false;
    await runWithConcurrency(jobs, concurrency, async (requestedJob) => {
      const intent: ImportCommitIntent = requestedJob.status === "failed"
        && requestedJob.failureStage === "commit"
        ? "retry"
        : "ready";
      let job = jobsRef.current.find((item) => item.id === requestedJob.id);
      if (!job || !importJobCanStartCommit(job, intent)) return;
      if (
        intent === "retry"
        && job.commitFailureCheckpoint === "unknown"
      ) {
        let status: StoredImportStatus | undefined;
        let statusError: unknown;
        try {
          if (!job.sessionId) throw new Error("提交会话不存在");
          status = await getStoredImportStatus(job.sessionId);
        } catch (error) {
          statusError = error;
        }
        const resolution = resolveCommitRetry(
          status,
          statusError ?? new Error("重试前状态校验未通过")
        );
        if ("patch" in resolution) updateJob(job.id, resolution.patch);
        if (resolution.action === "stop") return;
      }
      job = jobsRef.current.find((item) => item.id === requestedJob.id);
      if (!job || !importJobCanStartCommit(job, intent)) return;
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
        imported = true;
        const completed = completedImport(result, "已完成");
        completeJob(job.id, completed.patch, completed.item);
      } catch (error) {
        const outcome = await commitFailure(job, error);
        if (outcome.kind === "completed") {
          imported = true;
          completeJob(job.id, outcome.patch, outcome.item);
        } else {
          updateJob(job.id, outcome.patch);
        }
      }
    });
    if (imported) await invalidateImageData(client);
    onDone();
  }, [
    client,
    completeJob,
    concurrency,
    jobsRef,
    onDone,
    updateJob
  ]);
}
