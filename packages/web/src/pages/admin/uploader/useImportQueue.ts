import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ImageDraft, ImportJob } from "../../../lib/types.js";
import type { CommonAttributes } from "../../../lib/upload/upload-utils.js";

type QueueState = { jobs: ImportJob[]; page: number };
type QueueAction =
  | { type: "append"; jobs: ImportJob[]; pageSize: number }
  | { type: "retain-mode"; mode: "file" | "link" }
  | { type: "patch"; id: string; patch: Partial<ImportJob> }
  | { type: "patch-draft"; id: string; patch: Partial<ImageDraft> }
  | { type: "remove"; ids: Set<string>; pageSize: number }
  | { type: "apply-defaults"; defaults: CommonAttributes }
  | { type: "set-page"; page: number; pageSize: number };

function pageCount(length: number, pageSize: number) {
  return Math.max(1, Math.ceil(length / pageSize));
}

function classificationOverrideFor(job: Pick<ImportJob, "draft" | "resolvedClassification">) {
  const resolved = job.resolvedClassification;
  if (!resolved) return undefined;
  const classificationOverride: ImportJob["classificationOverride"] = {};
  if (job.draft.device !== resolved.device) classificationOverride.device = true;
  if (job.draft.brightness !== resolved.brightness) classificationOverride.brightness = true;
  return Object.keys(classificationOverride).length ? classificationOverride : undefined;
}

function patchJobDraft(job: ImportJob, patch: Partial<ImageDraft>): ImportJob {
  const next = { ...job, draft: { ...job.draft, ...patch } };
  return { ...next, classificationOverride: classificationOverrideFor(next) };
}

function applyDefaultsToJob(job: ImportJob, defaults: CommonAttributes): ImportJob {
  if (["done", "cancelled"].includes(job.status)) return job;
  const draftPatch: Partial<ImageDraft> = {
    ...(defaults.device ? { device: defaults.device as ImageDraft["device"] } : job.resolvedClassification ? { device: job.resolvedClassification.device } : {}),
    ...(defaults.brightness ? { brightness: defaults.brightness as ImageDraft["brightness"] } : job.resolvedClassification ? { brightness: job.resolvedClassification.brightness } : {}),
    ...(defaults.theme.trim() ? { theme: defaults.theme } : {}),
    ...(defaults.author.trim() ? { author: defaults.author } : {}),
    ...(defaults.tags.length ? { tags: [...defaults.tags] } : {})
  };
  return patchJobDraft(job, draftPatch);
}

function reducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "append": {
      const jobs = [...state.jobs, ...action.jobs];
      return { jobs, page: pageCount(jobs.length, action.pageSize) };
    }
    case "retain-mode":
      return { jobs: state.jobs.filter((job) => action.mode === "file" ? job.kind === "local" : job.kind !== "local"), page: 1 };
    case "patch":
      return { ...state, jobs: state.jobs.map((job) => job.id === action.id ? { ...job, ...action.patch } : job) };
    case "patch-draft":
      return {
        ...state,
        jobs: state.jobs.map((job) => job.id === action.id ? patchJobDraft(job, action.patch) : job)
      };
    case "remove": {
      const jobs = state.jobs.filter((job) => !action.ids.has(job.id));
      return { jobs, page: Math.min(state.page, pageCount(jobs.length, action.pageSize)) };
    }
    case "apply-defaults":
      return {
        ...state,
        jobs: state.jobs.map((job) => applyDefaultsToJob(job, action.defaults))
      };
    case "set-page":
      return { ...state, page: Math.max(1, Math.min(action.page, pageCount(state.jobs.length, action.pageSize))) };
  }
}

function revokeObjectUrl(job: ImportJob) {
  if (job.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(job.objectUrl);
}

export function useImportQueue(pageSize: number) {
  const [state, reactDispatch] = useReducer(reducer, { jobs: [], page: 1 });
  const stateRef = useRef(state);
  const jobsRef = useRef(state.jobs);
  const md5OwnersRef = useRef(new Map<string, string>());

  const dispatch = useCallback((action: QueueAction) => {
    // 上传/下载是异步并发流程，回调触发时 React state 可能已落后；ref 里同步维护最新队列供所有回调用。
    const next = reducer(stateRef.current, action);
    stateRef.current = next;
    jobsRef.current = next.jobs;
    reactDispatch(action);
  }, []);

  useEffect(() => () => jobsRef.current.forEach(revokeObjectUrl), []);
  useEffect(() => { dispatch({ type: "set-page", page: stateRef.current.page, pageSize }); }, [dispatch, pageSize]);

  const appendJobs = useCallback((jobs: ImportJob[]) => {
    if (jobs.length) dispatch({ type: "append", jobs, pageSize });
  }, [dispatch, pageSize]);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => dispatch({ type: "patch", id, patch }), [dispatch]);
  const updateJobDraft = useCallback((id: string, patch: Partial<ImageDraft>) => dispatch({ type: "patch-draft", id, patch }), [dispatch]);

  const claimPreparedMd5 = useCallback((id: string, md5: string) => {
    // 同一批次内最终文件 md5 重复时，只保留第一个任务进入“待提交”，其余任务取消服务端暂存。
    const owner = md5OwnersRef.current.get(md5);
    if (owner && owner !== id) return false;
    md5OwnersRef.current.set(md5, id);
    dispatch({ type: "patch", id, patch: { md5 } });
    return true;
  }, [dispatch]);

  const releaseJob = useCallback((job: ImportJob) => {
    // 本地预览 URL 由前端创建，任务离队时必须释放；服务端 preview_url 不需要 revoke。
    if (job.md5 && md5OwnersRef.current.get(job.md5) === job.id) md5OwnersRef.current.delete(job.md5);
    revokeObjectUrl(job);
  }, []);

  const removeJob = useCallback((id: string) => {
    const job = jobsRef.current.find((item) => item.id === id);
    if (job) releaseJob(job);
    dispatch({ type: "remove", ids: new Set([id]), pageSize });
  }, [dispatch, pageSize, releaseJob]);

  const clearJobs = useCallback((predicate: (job: ImportJob) => boolean) => {
    const removed = jobsRef.current.filter(predicate);
    removed.forEach(releaseJob);
    dispatch({ type: "remove", ids: new Set(removed.map((job) => job.id)), pageSize });
  }, [dispatch, pageSize, releaseJob]);

  const retainMode = useCallback((mode: "file" | "link") => {
    jobsRef.current.filter((job) => mode === "file" ? job.kind !== "local" : job.kind === "local").forEach(releaseJob);
    dispatch({ type: "retain-mode", mode });
  }, [dispatch, releaseJob]);

  const applyDefaultsToAll = useCallback((defaults: CommonAttributes) => dispatch({ type: "apply-defaults", defaults }), [dispatch]);
  const setPage = useCallback((next: number | ((current: number) => number)) => {
    const page = typeof next === "function" ? next(stateRef.current.page) : next;
    dispatch({ type: "set-page", page, pageSize });
  }, [dispatch, pageSize]);

  const totalPages = pageCount(state.jobs.length, pageSize);
  const visibleJobs = useMemo(() => state.jobs.slice((state.page - 1) * pageSize, state.page * pageSize), [pageSize, state.jobs, state.page]);

  return {
    jobs: state.jobs, jobsRef, page: state.page, totalPages, visibleJobs, setPage,
    appendJobs, retainMode, updateJob, updateJobDraft, claimPreparedMd5, removeJob,
    clearJobs, applyDefaultsToAll
  };
}
