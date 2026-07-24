import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageDraft, ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import {
  importQueuePageCount,
  reduceImportQueue,
  summarizeImportJobs,
  type ImportQueueAction,
  type ImportQueueState
} from "./import-queue-state.js";
import type { AppendImportQueueApi } from "./prepared-result.js";

function revokeObjectUrl(job: ImportJob) {
  if (job.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(job.objectUrl);
}

export function useImportQueue(pageSize: number) {
  const [state, setState] = useState<ImportQueueState>({ jobs: [], page: 1 });
  const stateRef = useRef(state);
  const jobsRef = useRef(state.jobs);

  const dispatch = useCallback((action: ImportQueueAction) => {
    // 上传/下载是异步并发流程，回调触发时 React state 可能已落后；ref 里同步维护最新队列供所有回调用。
    const current = stateRef.current;
    const next = reduceImportQueue(current, action);
    if (next === current) return;
    stateRef.current = next;
    jobsRef.current = next.jobs;
    setState(next);
  }, []);

  useEffect(() => () => jobsRef.current.forEach(revokeObjectUrl), []);
  useEffect(() => {
    dispatch({ type: "set-page", page: stateRef.current.page, pageSize });
  }, [dispatch, pageSize]);

  const appendJobs = useCallback((jobs: ImportJob[]) => {
    if (jobs.length) dispatch({ type: "append", jobs });
  }, [dispatch]);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => {
    dispatch({ type: "patch", id, patch });
  }, [dispatch]);

  const updateJobDraft = useCallback((id: string, patch: Partial<ImageDraft>) => {
    dispatch({ type: "patch-draft", id, patch });
  }, [dispatch]);

  const releaseJob = useCallback((job: ImportJob) => {
    // 本地预览 URL 由前端创建，任务离队时必须释放；服务端 preview_url 不需要 revoke。
    revokeObjectUrl(job);
  }, []);

  const removeJob = useCallback((id: string) => {
    const job = jobsRef.current.find((item) => item.id === id);
    if (job) releaseJob(job);
    dispatch({ type: "remove", ids: new Set([id]), pageSize });
  }, [dispatch, pageSize, releaseJob]);

  const clearJobIds = useCallback((ids: ReadonlySet<string>) => {
    const removed = jobsRef.current.filter((job) => ids.has(job.id));
    removed.forEach(releaseJob);
    dispatch({ type: "remove", ids: new Set(removed.map((job) => job.id)), pageSize });
  }, [dispatch, pageSize, releaseJob]);

  const clearJobs = useCallback((predicate: (job: ImportJob) => boolean) => {
    clearJobIds(new Set(jobsRef.current.filter(predicate).map((job) => job.id)));
  }, [clearJobIds]);

  const retainMode = useCallback((mode: "file" | "link") => {
    jobsRef.current
      .filter((job) => mode === "file" ? job.kind !== "local" : job.kind === "local")
      .forEach(releaseJob);
    dispatch({ type: "retain-mode", mode });
  }, [dispatch, releaseJob]);

  const applyDefaultsToAll = useCallback((defaults: ImportAttributeDefaults) => {
    dispatch({ type: "apply-defaults", defaults });
  }, [dispatch]);

  const setPage = useCallback((next: number | ((current: number) => number)) => {
    const page = typeof next === "function" ? next(stateRef.current.page) : next;
    dispatch({ type: "set-page", page, pageSize });
  }, [dispatch, pageSize]);

  const totalPages = importQueuePageCount(state.jobs.length, pageSize);
  const visibleJobs = useMemo(
    () => state.jobs.slice((state.page - 1) * pageSize, state.page * pageSize),
    [pageSize, state.jobs, state.page]
  );
  const summary = useMemo(() => summarizeImportJobs(state.jobs), [state.jobs]);
  const workerApi = useMemo<AppendImportQueueApi>(() => ({
    jobsRef,
    appendJobs,
    updateJob
  }), [appendJobs, jobsRef, updateJob]);

  return {
    jobs: state.jobs,
    jobsRef,
    page: state.page,
    totalPages,
    visibleJobs,
    summary,
    workerApi,
    setPage,
    appendJobs,
    retainMode,
    updateJob,
    updateJobDraft,
    removeJob,
    clearJobIds,
    clearJobs,
    applyDefaultsToAll
  };
}

export type ImportQueueController = ReturnType<typeof useImportQueue>;
