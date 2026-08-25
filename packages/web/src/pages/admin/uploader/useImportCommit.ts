import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ImportJob } from "../../../lib/types.js";
import {
  createImportCommitIntent,
  importJobCanStartCommit,
  type ImportCommitRequest
} from "./import-queue-state.js";
import { commitSelectedImports } from "./import-commit-batch.js";
import { importJobNeedsDuplicateConfirmation } from "./duplicate-match.js";
import type {
  CompletedImportObservation
} from "./import-queue-api.js";
import { serverImportJobPairKey } from "./server-import-job.js";

export function useImportCommit(options: {
  jobsRef: RefObject<ImportJob[]>;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  updateJobs: (patches: ReadonlyMap<string, Partial<ImportJob>>) => void;
  updateDuplicateDecision: (
    id: string,
    decision: "upload" | "confirmed"
  ) => Promise<boolean>;
  flushPendingUpdates: () => Promise<void>;
  observeCompletedImports: (
    entries: readonly CompletedImportObservation[]
  ) => void;
  onDone: () => void;
}) {
  const {
    jobsRef,
    updateJob,
    updateJobs,
    updateDuplicateDecision,
    flushPendingUpdates,
    observeCompletedImports,
    onDone
  } = options;
  const runnerActiveRef = useRef(false);
  const duplicateActiveRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const commit = useCallback(async (
    jobs: ImportJob[],
    settings: Readonly<{ notifyDone?: boolean }> = {}
  ) => {
    if (runnerActiveRef.current) return false;
    runnerActiveRef.current = true;
    setBusy(true);
    try {
      try {
        await flushPendingUpdates();
      } catch {
        return false;
      }
      const selected: ImportJob[] = [];
      const selectedPairs = new Set<string>();
      const patches = new Map<string, Partial<ImportJob>>();
      for (const requested of jobs) {
        const current = jobsRef.current.find((job) => (
          job.id === requested.id && job.attemptKey === requested.attemptKey
        ));
        const request: ImportCommitRequest = current?.commitIntent
          ? "resume"
          : "new";
        if (!current || !importJobCanStartCommit(current, request)) continue;
        if (!current.sessionId || !current.imageId || !current.serverVersion) {
          updateJob(current.id, {
            status: "failed",
            failureStage: current.commitIntent ? "commit" : "prepare",
            commitFailureCheckpoint: current.commitIntent ? "unknown" : undefined,
            message: "导入任务缺少服务端 pair 或版本，需要重新同步"
          });
          continue;
        }
        const pair = serverImportJobPairKey(current);
        if (selectedPairs.has(pair)) continue;
        selectedPairs.add(pair);
        const commitIntent = current.commitIntent
          ?? createImportCommitIntent(current);
        const patch: Partial<ImportJob> = {
          status: "commit-queued",
          commitIntent,
          failureStage: undefined,
          commitFailureCheckpoint: undefined,
          resultState: "pending",
          resultError: undefined,
          message: "正在受理提交意图"
        };
        patches.set(current.id, patch);
        selected.push({ ...current, ...patch, commitIntent });
      }
      updateJobs(patches);
      if (!selected.length) return false;
      const accepted = await commitSelectedImports({
        selected,
        getJob: (id) => jobsRef.current.find((job) => job.id === id),
        observeCompletedImports,
        updateJob
      });
      if (accepted && settings.notifyDone !== false) onDone();
      return accepted > 0;
    } finally {
      runnerActiveRef.current = false;
      setBusy(false);
    }
  }, [
    flushPendingUpdates,
    jobsRef,
    observeCompletedImports,
    onDone,
    updateJob,
    updateJobs
  ]);

  const confirmDuplicate = useCallback(async (jobId: string) => {
    if (runnerActiveRef.current || duplicateActiveRef.current) return false;
    duplicateActiveRef.current = true;
    setBusy(true);
    let resumeJob: ImportJob | null = null;
    try {
      let job = jobsRef.current.find((item) => item.id === jobId);
      if (!job || !importJobNeedsDuplicateConfirmation(job)) return false;
      if (!await updateDuplicateDecision(job.id, "confirmed")) return false;
      job = jobsRef.current.find((item) => item.id === jobId);
      if (!job) return false;
      if (!job.commitIntent) return true;
      if (!importJobCanStartCommit(job, "resume")) return false;
      resumeJob = job;
    } finally {
      duplicateActiveRef.current = false;
      setBusy(false);
    }
    return resumeJob ? commit([resumeJob]) : false;
  }, [commit, jobsRef, updateDuplicateDecision]);

  return { commit, confirmDuplicate, busy };
}
