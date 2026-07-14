import { useCallback, useRef } from "react";
import type { ImportJob } from "../../../../lib/types.js";
import {
  normalizeAuthor,
  normalizeTheme,
  runWithConcurrency,
  type CommonImageAttributes
} from "../../../../lib/upload/upload-utils.js";
import { linkImportJobs, retryPrepareJob } from "../import-job-utils.js";
import { batchDuplicateFromJob } from "../duplicate-match.js";
import { isCurrentImportAttempt, type AppendImportQueueApi } from "../prepared-result.js";
import {
  cancelStoredImport,
  createImportSessionsBatch,
  type ImportSessionCreateInput,
  type ImportSessionHandle
} from "../import-api.js";
import { applyImportAttemptFailure, runImportAttempt } from "../import-attempt.js";
import type { LinkImportMode } from "./LinkUrlDialog.js";

function linkSessionInput(job: ImportJob): ImportSessionCreateInput {
  return {
    ...job.draft,
    mode: job.kind === "proxy" ? "proxy" : "download",
    source_url: job.url,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author),
    storage_slug: job.storageSlug,
    idempotency_key: job.attemptKey,
    image_time: job.imageTime,
    batch_time: job.batchTime,
    manifest_position: job.manifestPosition
  };
}

export function useLinkImport(options: {
  queue: AppendImportQueueApi;
  defaults: CommonImageAttributes;
  fillOriginalUrl: boolean;
  storageSlug: string;
  concurrency: number;
}) {
  const { queue, defaults, fillOriginalUrl, storageSlug, concurrency } = options;
  const controllers = useRef(new Map<string, AbortController>());

  const prepare = useCallback(async (job: ImportJob, existingSession?: ImportSessionHandle) => {
    if (!job.url || job.kind === "local") return;
    const attemptKey = job.attemptKey;
    const isProxy = job.kind === "proxy";
    const controller = new AbortController();
    controllers.current.set(job.id, controller);
    try {
      if (!existingSession) {
        queue.updateJob(job.id, {
          status: "queued",
          message: isProxy ? "创建代理导入会话" : "创建下载会话"
        });
      }
      const result = await runImportAttempt({
        queue,
        job,
        controller,
        createInput: linkSessionInput(job),
        session: existingSession,
        onSession: (session) => {
          queue.updateJob(job.id, {
            status: isProxy ? "processing" : "downloading",
            message: isProxy ? "探测外链并生成代理缩略图" : "服务端下载原图",
            sessionId: session.id
          });
        },
        onPreparing: () => {
          queue.updateJob(job.id, {
            status: isProxy ? "processing" : "downloading",
            message: isProxy ? "探测外链并生成代理缩略图" : "服务端下载原图"
          });
        }
      });
      if (!result) return;

      const applied = result.acceptance;
      const duplicateExists = result.prepared.duplicate_exists
        || result.prepared.duplicates.length > 0;
      const shouldSkip = applied.status === "duplicate"
        || (job.duplicatePolicy === "skip" && duplicateExists);
      if (shouldSkip) {
        if (isCurrentImportAttempt(queue, job.id, attemptKey)) {
          const duplicates = result.prepared.duplicates ?? [];
          const libraryDuplicate = duplicates[0];
          const duplicateOwnerId = applied.status === "duplicate"
            ? applied.ownerId
            : "";
          const owner = duplicateOwnerId
            ? queue.jobsRef.current.find((item) => item.id === duplicateOwnerId)
            : undefined;
          const batchDuplicate = !libraryDuplicate && owner
            ? batchDuplicateFromJob(owner)
            : undefined;
          queue.updateJob(job.id, {
            status: "skipped",
            message: libraryDuplicate
              ? `与图库中 ${duplicates.length} 张图片的最终文件重复，已跳过`
              : owner?.manifestLine
                ? `与 JSONL 第 ${owner.manifestLine} 行的处理后文件重复，已跳过`
                : "与同批处理任务的最终文件重复，已跳过",
            ...(libraryDuplicate ? {
              preview: libraryDuplicate.thumb_url,
              previewFull: libraryDuplicate.object_url,
              width: libraryDuplicate.width,
              height: libraryDuplicate.height,
              batchDuplicate: undefined
            } : batchDuplicate ? {
              preview: batchDuplicate.preview,
              previewFull: batchDuplicate.previewFull,
              width: batchDuplicate.width,
              height: batchDuplicate.height,
              batchDuplicate
            } : {}),
            duplicateDecision: "upload"
          });
        }
        await cancelStoredImport(result.session.id).catch(() => undefined);
      }
    } catch (error) {
      applyImportAttemptFailure(queue, job.id, attemptKey, error);
    } finally {
      if (controllers.current.get(job.id) === controller) controllers.current.delete(job.id);
    }
  }, [queue]);

  const addBatch = useCallback(async (jobs: ImportJob[], source: "urls" | "jsonl") => {
    queue.appendJobs(jobs);
    if (!jobs.length) return;
    for (const job of jobs) {
      queue.updateJob(job.id, { status: "queued", message: "批量创建导入会话" });
    }

    let results;
    try {
      results = await createImportSessionsBatch(source, jobs.map(linkSessionInput));
    } catch (error) {
      for (const job of jobs) applyImportAttemptFailure(queue, job.id, job.attemptKey, error);
      return;
    }

    const jobByAttempt = new Map(jobs.map((job) => [job.attemptKey, job] as const));
    const returnedAttempts = new Set<string>();
    const accepted: Array<{ job: ImportJob; session: ImportSessionHandle }> = [];
    for (const result of results) {
      returnedAttempts.add(result.idempotency_key);
      const job = jobByAttempt.get(result.idempotency_key);
      if (!job) continue;
      if ("error" in result) {
        applyImportAttemptFailure(queue, job.id, job.attemptKey, new Error(result.error));
        continue;
      }
      if (!isCurrentImportAttempt(queue, job.id, job.attemptKey)) {
        await cancelStoredImport(result.session.id).catch(() => undefined);
        continue;
      }
      queue.updateJob(job.id, { sessionId: result.session.id });
      accepted.push({ job, session: result.session });
    }
    for (const job of jobs) {
      if (!returnedAttempts.has(job.attemptKey)) {
        applyImportAttemptFailure(queue, job.id, job.attemptKey, new Error("服务端未返回导入会话结果"));
      }
    }
    await runWithConcurrency(accepted, concurrency, ({ job, session }) => prepare(job, session));
  }, [concurrency, prepare, queue]);

  const addUrls = useCallback(async (urls: string[], mode: LinkImportMode) => {
    const jobs = linkImportJobs(mode, urls, defaults, fillOriginalUrl, storageSlug);
    await addBatch(jobs, "urls");
  }, [addBatch, defaults, fillOriginalUrl, storageSlug]);

  const addJobs = useCallback(async (jobs: ImportJob[]) => {
    await addBatch(jobs, "jsonl");
  }, [addBatch]);

  const cancel = useCallback(async (job: ImportJob) => {
    controllers.current.get(job.id)?.abort();
    queue.updateJob(job.id, { status: "cancelled", message: "已取消" });
    if (job.sessionId) await cancelStoredImport(job.sessionId).catch(() => undefined);
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    if (job.sessionId) await cancelStoredImport(job.sessionId).catch(() => undefined);
    queue.releasePreparedMd5(job.id);
    const next = retryPrepareJob(job);
    queue.updateJob(job.id, next);
    await prepare(next);
  }, [prepare, queue]);

  return { addUrls, addJobs, cancel, retry };
}
