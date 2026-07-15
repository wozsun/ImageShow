import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ImageDraft, ImportJob } from "../../../lib/types.js";
import type { CommonImageAttributes } from "../../../lib/upload/upload-utils.js";
import {
  claimPreparedMd5Owner,
  detachRemovedBatchDuplicateOwners,
  releasePreparedMd5Owner,
  refreshBatchDuplicateMatches
} from "./duplicate-match.js";

const preparedMd5ReleaseStatuses = new Set<ImportJob["status"]>(["done", "skipped", "failed", "cancelled"]);

type QueueState = { jobs: ImportJob[]; page: number };
type QueueAction =
  | { type: "append"; jobs: ImportJob[]; pageSize: number }
  | { type: "retain-mode"; mode: "file" | "link" }
  | { type: "patch"; id: string; patch: Partial<ImportJob> }
  | { type: "patch-draft"; id: string; patch: Partial<ImageDraft> }
  | { type: "remove"; ids: Set<string>; pageSize: number }
  | { type: "apply-defaults"; defaults: CommonImageAttributes }
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

/** @internal Exported only for local import queue verification. */
export function applyDefaultsToJob(job: ImportJob, defaults: CommonImageAttributes): ImportJob {
  if (["done", "skipped", "cancelled"].includes(job.status)) return job;
  const inlineFields = new Set(job.inlineMetadataFields ?? []);
  const draftPatch: Partial<ImageDraft> = {
    ...(!inlineFields.has("device") && defaults.device ? { device: defaults.device as ImageDraft["device"] } : !inlineFields.has("device") && job.resolvedClassification ? { device: job.resolvedClassification.device } : {}),
    ...(!inlineFields.has("brightness") && defaults.brightness ? { brightness: defaults.brightness as ImageDraft["brightness"] } : !inlineFields.has("brightness") && job.resolvedClassification ? { brightness: job.resolvedClassification.brightness } : {}),
    ...(!inlineFields.has("theme") && defaults.theme.trim() ? { theme: defaults.theme } : {}),
    ...(!inlineFields.has("author") && defaults.author.trim() ? { author: defaults.author } : {}),
    ...(!inlineFields.has("tags") && defaults.tags.length ? { tags: [...defaults.tags] } : {})
  };
  return patchJobDraft(job, draftPatch);
}

function reducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "append": {
      const jobs = [...action.jobs, ...state.jobs];
      return { jobs, page: 1 };
    }
    case "retain-mode":
      return { jobs: state.jobs.filter((job) => action.mode === "file" ? job.kind === "local" : job.kind !== "local"), page: 1 };
    case "patch":
      return {
        ...state,
        jobs: refreshBatchDuplicateMatches(
          state.jobs.map((job) => job.id === action.id ? { ...job, ...action.patch } : job),
          action.id
        )
      };
    case "patch-draft":
      return {
        ...state,
        jobs: state.jobs.map((job) => job.id === action.id ? patchJobDraft(job, action.patch) : job)
      };
    case "remove": {
      const jobs = detachRemovedBatchDuplicateOwners(state.jobs, action.ids);
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

  const releasePreparedMd5 = useCallback((id: string) => {
    const job = jobsRef.current.find((item) => item.id === id);
    if (!job?.md5) return false;
    return releasePreparedMd5Owner(md5OwnersRef.current, id, job.md5);
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => {
    if (patch.status && preparedMd5ReleaseStatuses.has(patch.status)) {
      const current = jobsRef.current.find((item) => item.id === id);
      const md5 = patch.md5 ?? current?.md5;
      if (md5) releasePreparedMd5Owner(md5OwnersRef.current, id, md5);
    }
    dispatch({ type: "patch", id, patch });
  }, [dispatch]);
  const updateJobDraft = useCallback((id: string, patch: Partial<ImageDraft>) => dispatch({ type: "patch-draft", id, patch }), [dispatch]);

  const claimPreparedMd5 = useCallback((id: string, md5: string) => {
    // 同一批次内最终文件 md5 重复时，只保留第一个任务进入“待提交”，其余任务取消服务端暂存。
    const claim = claimPreparedMd5Owner(md5OwnersRef.current, id, md5);
    if (!claim.claimed) return claim;
    dispatch({ type: "patch", id, patch: { md5 } });
    return claim;
  }, [dispatch]);

  const releaseJob = useCallback((job: ImportJob) => {
    // 本地预览 URL 由前端创建，任务离队时必须释放；服务端 preview_url 不需要 revoke。
    if (job.md5) releasePreparedMd5Owner(md5OwnersRef.current, job.id, job.md5);
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
    jobsRef.current.filter((job) => mode === "file" ? job.kind !== "local" : job.kind === "local").forEach(releaseJob);
    dispatch({ type: "retain-mode", mode });
  }, [dispatch, releaseJob]);

  const applyDefaultsToAll = useCallback((defaults: CommonImageAttributes) => dispatch({ type: "apply-defaults", defaults }), [dispatch]);
  const setPage = useCallback((next: number | ((current: number) => number)) => {
    const page = typeof next === "function" ? next(stateRef.current.page) : next;
    dispatch({ type: "set-page", page, pageSize });
  }, [dispatch, pageSize]);

  const totalPages = pageCount(state.jobs.length, pageSize);
  const visibleJobs = useMemo(() => state.jobs.slice((state.page - 1) * pageSize, state.page * pageSize), [pageSize, state.jobs, state.page]);

  return {
    jobs: state.jobs, jobsRef, page: state.page, totalPages, visibleJobs, setPage,
    appendJobs, retainMode, updateJob, updateJobDraft, claimPreparedMd5,
    releasePreparedMd5, removeJob, clearJobIds, clearJobs, applyDefaultsToAll
  };
}
