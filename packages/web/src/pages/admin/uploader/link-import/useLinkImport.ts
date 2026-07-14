import { useCallback, useRef } from "react";
import type { ImportJob } from "../../../../lib/types.js";
import { normalizeAuthor, normalizeTheme, runWithConcurrency, type CommonImageAttributes } from "../../../../lib/upload/upload-utils.js";
import { linkImportJobs, retryPrepareJob } from "../import-job-utils.js";
import { batchDuplicateFromJob } from "../duplicate-match.js";
import { applyPreparedResult, isCurrentImportAttempt, type AppendImportQueueApi } from "../prepared-result.js";
import { cancelStoredImport, createImportSession, prepareImportSession } from "../import-api.js";
import type { LinkImportMode } from "./LinkUrlDialog.js";

export function useLinkImport(options: {
  queue: AppendImportQueueApi;
  defaults: CommonImageAttributes;
  fillOriginalUrl: boolean;
  storageSlug: string;
  concurrency: number;
}) {
  const { queue, defaults, fillOriginalUrl, storageSlug, concurrency } = options;
  const controllers = useRef(new Map<string, AbortController>());

  const prepare = useCallback(async (job: ImportJob) => {
    if (!job.url || job.kind === "local") return;
    const attemptKey = job.attemptKey;
    const isProxy = job.kind === "proxy";
    const controller = new AbortController();
    controllers.current.set(job.id, controller);
    try {
      queue.updateJob(job.id, { status: "queued", message: isProxy ? "创建代理导入会话" : "创建下载会话" });
      const session = await createImportSession({
        ...job.draft,
        mode: job.kind,
        source_url: job.url,
        theme: normalizeTheme(job.draft.theme),
        author: normalizeAuthor(job.draft.author),
        storage_slug: job.storageSlug,
        idempotency_key: attemptKey,
        image_time: job.imageTime,
        batch_time: job.batchTime,
        manifest_position: job.manifestPosition
      }, controller.signal);
      if (!isCurrentImportAttempt(queue, job.id, attemptKey)) {
        await cancelStoredImport(session.id).catch(() => undefined);
        return;
      }
      queue.updateJob(job.id, {
        status: isProxy ? "processing" : "downloading",
        message: isProxy ? "探测外链并生成代理缩略图" : "服务端下载原图",
        sessionId: session.id
      });
      const prepared = await prepareImportSession(session, controller.signal);
      const applied = applyPreparedResult(queue, job.id, attemptKey, prepared);
      const duplicateExists = prepared.duplicate_exists || prepared.duplicates.length > 0;
      const shouldSkip = applied.status === "duplicate"
        || (job.duplicatePolicy === "skip" && duplicateExists);
      if (shouldSkip) {
        if (isCurrentImportAttempt(queue, job.id, attemptKey)) {
          const duplicates = prepared.duplicates ?? [];
          const libraryDuplicate = duplicates[0];
          const owner = applied.status === "duplicate"
            ? queue.jobsRef.current.find((item) => item.id === applied.ownerId)
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
        await cancelStoredImport(session.id).catch(() => undefined);
      } else if (applied.status === "stale") {
        await cancelStoredImport(session.id).catch(() => undefined);
      }
    } catch (error) {
      const current = queue.jobsRef.current.find((item) => item.id === job.id);
      if (current?.attemptKey === attemptKey && current.status !== "cancelled") {
        queue.updateJob(job.id, { status: "failed", failureStage: "prepare", message: (error as Error).message });
      }
    } finally {
      if (controllers.current.get(job.id) === controller) controllers.current.delete(job.id);
    }
  }, [queue]);

  const addUrls = useCallback(async (urls: string[], mode: LinkImportMode) => {
    const jobs = linkImportJobs(mode, urls, defaults, fillOriginalUrl, storageSlug);
    queue.appendJobs(jobs);
    await runWithConcurrency(jobs, concurrency, prepare);
  }, [concurrency, defaults, fillOriginalUrl, prepare, queue, storageSlug]);

  const addJobs = useCallback(async (jobs: ImportJob[]) => {
    queue.appendJobs(jobs);
    await runWithConcurrency(jobs, concurrency, prepare);
  }, [concurrency, prepare, queue]);

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
