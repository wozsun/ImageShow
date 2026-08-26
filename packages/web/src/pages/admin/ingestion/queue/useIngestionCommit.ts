import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { IngestionJob } from "../../../../lib/types.js";
import {
  createIngestionCommitIntent,
  ingestionJobCanStartCommit,
  type IngestionCommitRequest
} from "./model/ingestion-queue-state.js";
import { commitSelectedIngestions } from "./ingestion-commit-batch.js";
import { ingestionJobNeedsDuplicateConfirmation } from "./model/duplicate-match.js";
import type {
  CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import { serverIngestionJobPairKey } from "./model/server-ingestion-job.js";

export function useIngestionCommit(options: {
  jobsRef: RefObject<IngestionJob[]>;
  updateJob: (id: string, patch: Partial<IngestionJob>) => void;
  updateJobs: (patches: ReadonlyMap<string, Partial<IngestionJob>>) => void;
  updateDuplicateDecision: (
    id: string,
    decision: "upload" | "confirmed"
  ) => Promise<boolean>;
  flushPendingUpdates: () => Promise<void>;
  observeCompletedIngestions: (
    entries: readonly CompletedIngestionObservation[]
  ) => void;
  onDone: () => void;
}) {
  const {
    jobsRef,
    updateJob,
    updateJobs,
    updateDuplicateDecision,
    flushPendingUpdates,
    observeCompletedIngestions,
    onDone
  } = options;
  const runnerActiveRef = useRef(false);
  const duplicateActiveRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const commit = useCallback(async (
    jobs: IngestionJob[],
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
      const selected: IngestionJob[] = [];
      const selectedPairs = new Set<string>();
      const patches = new Map<string, Partial<IngestionJob>>();
      for (const requested of jobs) {
        const current = jobsRef.current.find((job) => (
          job.id === requested.id && job.attemptKey === requested.attemptKey
        ));
        const request: IngestionCommitRequest = current?.commitIntent
          ? "resume"
          : "new";
        if (!current || !ingestionJobCanStartCommit(current, request)) continue;
        if (!current.sessionId || !current.imageId || !current.serverVersion) {
          updateJob(current.id, {
            status: "failed",
            failureStage: current.commitIntent ? "commit" : "prepare",
            commitFailureCheckpoint: current.commitIntent ? "unknown" : undefined,
            message: "内容接入任务缺少服务端 pair 或版本，需要重新同步"
          });
          continue;
        }
        const pair = serverIngestionJobPairKey(current);
        if (selectedPairs.has(pair)) continue;
        selectedPairs.add(pair);
        const commitIntent = current.commitIntent
          ?? createIngestionCommitIntent(current);
        const patch: Partial<IngestionJob> = {
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
      const accepted = await commitSelectedIngestions({
        selected,
        getJob: (id) => jobsRef.current.find((job) => job.id === id),
        observeCompletedIngestions,
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
    observeCompletedIngestions,
    onDone,
    updateJob,
    updateJobs
  ]);

  const confirmDuplicate = useCallback(async (jobId: string) => {
    if (runnerActiveRef.current || duplicateActiveRef.current) return false;
    duplicateActiveRef.current = true;
    setBusy(true);
    let resumeJob: IngestionJob | null = null;
    try {
      let job = jobsRef.current.find((item) => item.id === jobId);
      if (!job || !ingestionJobNeedsDuplicateConfirmation(job)) return false;
      if (!await updateDuplicateDecision(job.id, "confirmed")) return false;
      job = jobsRef.current.find((item) => item.id === jobId);
      if (!job) return false;
      if (!job.commitIntent) return true;
      if (!ingestionJobCanStartCommit(job, "resume")) return false;
      resumeJob = job;
    } finally {
      duplicateActiveRef.current = false;
      setBusy(false);
    }
    return resumeJob ? commit([resumeJob]) : false;
  }, [commit, jobsRef, updateDuplicateDecision]);

  return { commit, confirmDuplicate, busy };
}
