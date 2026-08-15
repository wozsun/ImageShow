import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AdminImageListItem, ImportJob } from "../../../lib/types.js";
import { runWithConcurrency } from "../../../lib/upload/upload-utils.js";
import {
  getStoredImportStatus,
  type StoredImportStatus
} from "./import-api.js";
import {
  invalidateImageDataAfterImport
} from "../../../lib/api/query-invalidation.js";
import {
  importStatusEventPatch,
  resolveCommitRetry
} from "./import-status-state.js";
import {
  createImportCommitIntent,
  importJobCanStartCommit,
  importJobIsRecoveringCommitResult,
  type ImportCommitRequest
} from "./import-queue-state.js";
import { commitSelectedImports } from "./import-commit-batch.js";
import {
  importJobNeedsDuplicateConfirmation
} from "./duplicate-match.js";

export function useImportCommit(options: {
  jobsRef: RefObject<ImportJob[]>;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  updateJobs: (patches: ReadonlyMap<string, Partial<ImportJob>>) => void;
  completeJob: (
    id: string,
    commitAttemptId: string,
    patch: Partial<ImportJob>,
    item: AdminImageListItem
  ) => boolean;
  concurrency: number;
  onDone: () => void;
}) {
  const {
    jobsRef,
    updateJob,
    updateJobs,
    completeJob,
    concurrency,
    onDone
  } = options;
  const client = useQueryClient();
  const runnerActiveRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const commit = useCallback(async (jobs: ImportJob[]) => {
    // This ref is acquired synchronously, before the first await or reducer
    // write, so a double click/React re-entry cannot create a second intent.
    if (runnerActiveRef.current) return false;
    runnerActiveRef.current = true;
    setBusy(true);
    try {
      const candidates = new Map<string, ImportCommitRequest>();
      await runWithConcurrency(jobs, concurrency, async (requestedJob) => {
        let job = jobsRef.current.find((item) => item.id === requestedJob.id);
        const request: ImportCommitRequest = job?.commitIntent
          ? "resume"
          : "new";
        if (!job || !importJobCanStartCommit(job, request)) return;

        if (
          request === "resume"
          && job.status === "failed"
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
          if (status) {
            const authorityPatch = importStatusEventPatch(job, status);
            if (authorityPatch) updateJob(job.id, authorityPatch);
            job = jobsRef.current.find((item) => item.id === requestedJob.id);
            if (!job) return;
          }
          const resolution = resolveCommitRetry(
            status,
            statusError ?? new Error("重试前状态校验未通过")
          );
          if (resolution.patch) updateJob(job.id, resolution.patch);
          if (resolution.action === "stop") return;
        }
        candidates.set(requestedJob.id, request);
      });

      // Re-read every candidate without yielding, validate it again, then
      // publish all immutable intents and commit-queued states atomically.
      const selected: ImportJob[] = [];
      const selectedSessionIds = new Set<string>();
      const patches = new Map<string, Partial<ImportJob>>();
      for (const requestedJob of jobs) {
        const request = candidates.get(requestedJob.id);
        if (!request) continue;
        const current = jobsRef.current.find(
          (item) => item.id === requestedJob.id
        );
        if (!current || !importJobCanStartCommit(current, request)) continue;
        if (!current.sessionId) {
          updateJob(current.id, current.commitIntent ? {
            status: "failed",
            failureStage: "commit",
            commitFailureCheckpoint: "unknown",
            message: "提交会话不存在，无法继续提交"
          } : {
            status: "failed",
            failureStage: "prepare",
            commitFailureCheckpoint: undefined,
            message: "提交会话不存在，需要重新处理"
          });
          continue;
        }
        const sessionKey = current.sessionId.toLowerCase();
        if (selectedSessionIds.has(sessionKey)) continue;
        selectedSessionIds.add(sessionKey);

        const commitIntent = current.commitIntent
          ?? createImportCommitIntent(current);
        const recoveringResult = importJobIsRecoveringCommitResult(current);
        const status: ImportJob["status"] =
          current.status === "finalized" || current.serverStatus === "finalized"
            ? "finalized"
            : current.status === "committing"
                || current.serverStatus === "committing"
              ? "committing"
              : "commit-queued";
        const patch: Partial<ImportJob> = {
          status,
          commitIntent,
          failureStage: undefined,
          commitFailureCheckpoint: undefined,
          resultState: recoveringResult ? "recovering" : "pending",
          resultError: undefined,
          message: status === "finalized"
            ? recoveringResult
              ? "正在确认提交结果"
              : "已写入图库，等待结果"
            : status === "committing"
              ? recoveringResult
                ? "正在确认提交结果"
                : "写入图库中"
              : "等待提交"
        };
        patches.set(current.id, patch);
        selected.push({ ...current, ...patch, commitIntent });
      }

      updateJobs(patches);
      if (!selected.length) return false;
      const importedItems = await commitSelectedImports({
        selected,
        concurrency,
        getJob: (id) => jobsRef.current.find((job) => job.id === id),
        updateJob,
        completeJob
      });
      if (importedItems.length) {
        await invalidateImageDataAfterImport(client, importedItems);
      }
      onDone();
      return importedItems.length > 0;
    } finally {
      runnerActiveRef.current = false;
      setBusy(false);
    }
  }, [
    client,
    completeJob,
    concurrency,
    jobsRef,
    onDone,
    updateJob,
    updateJobs
  ]);

  const confirmDuplicate = useCallback(async (jobId: string) => {
    // The same synchronous fence protects the confirmation patch and the
    // immediate resubmission, including double-clicks before React rerenders.
    if (runnerActiveRef.current) return false;
    let job = jobsRef.current.find((item) => item.id === jobId);
    if (!job || !importJobNeedsDuplicateConfirmation(job)) return false;

    updateJob(job.id, { duplicateDecision: "confirmed" });
    job = jobsRef.current.find((item) => item.id === jobId);
    if (!job) return false;
    if (!job.commitIntent) return true;
    if (!importJobCanStartCommit(job, "resume")) return false;
    return commit([job]);
  }, [commit, jobsRef, updateJob]);

  return { commit, confirmDuplicate, busy };
}
