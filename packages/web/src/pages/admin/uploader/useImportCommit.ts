import { useCallback } from "react";
import type { RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AdminImageListItem, ImportJob } from "../../../lib/types.js";
import { runWithConcurrency } from "../../../lib/upload/upload-utils.js";
import {
  getStoredImportStatus,
  type StoredImportStatus
} from "./import-api.js";
import { invalidateImageData } from "../../../lib/api/query-invalidation.js";
import {
  resolveCommitRetry
} from "./import-status-state.js";
import {
  importJobCanStartCommit,
  type ImportCommitIntent
} from "./import-queue-state.js";
import {
  commitSelectedImports
} from "./import-commit-batch.js";

export function useImportCommit(options: {
  jobsRef: RefObject<ImportJob[]>;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  completeJob: (id: string, patch: Partial<ImportJob>, item: AdminImageListItem) => void;
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
    const selected: ImportJob[] = [];
    const selectedSessionIds = new Set<string>();
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
      if (!job.sessionId) {
        updateJob(job.id, {
          status: "failed",
          failureStage: "prepare",
          commitFailureCheckpoint: undefined,
          message: "提交会话不存在，需要重新处理"
        });
        return;
      }
      const sessionKey = job.sessionId.toLowerCase();
      if (selectedSessionIds.has(sessionKey)) return;
      selectedSessionIds.add(sessionKey);
      updateJob(job.id, {
        status: "committing",
        failureStage: undefined,
        commitFailureCheckpoint: undefined,
        message: "写入图库"
      });
      selected.push(job);
    });

    const imported = selected.length
      ? await commitSelectedImports({
          selected,
          concurrency,
          updateJob,
          completeJob
        })
      : false;
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
