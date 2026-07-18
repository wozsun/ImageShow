import { useCallback, useRef } from "react";
import type { ImportJob } from "../../../lib/types.js";
import { browserUuid, draftFromFile, isUploadableImage, normalizeAuthor, normalizeTheme, runWithConcurrency, type CommonImageAttributes } from "../../../lib/upload/upload-utils.js";
import { retryPrepareJob } from "./import-job-utils.js";
import { isCurrentImportAttempt, type AppendImportQueueApi } from "./prepared-result.js";
import { cancelStoredImport, uploadLocalRaw } from "./import-api.js";
import { applyImportAttemptFailure, runImportAttempt } from "./import-attempt.js";

function fileFingerprint(file: File) {
  // 这里只做浏览器内“同一文件重复选择”的快速去重；最终内容去重仍以服务端标准化后的 md5 为准。
  return [file.name, file.size, file.lastModified, file.webkitRelativePath || ""].join("\u0000");
}

export function useLocalUploadImport(options: {
  queue: AppendImportQueueApi;
  defaults: CommonImageAttributes;
  storageSlug: string;
  maxItems: number;
  maxBytes: number;
  concurrency: number;
}) {
  const { queue, defaults, storageSlug, maxItems, maxBytes, concurrency } = options;
  const activeRequests = useRef(new Map<string, { attemptKey: string; abort: () => void }>());

  const prepare = useCallback(async (job: ImportJob) => {
    if (!job.file) return;
    const attemptKey = job.attemptKey;
    const controller = new AbortController();
    activeRequests.current.set(job.id, { attemptKey, abort: () => controller.abort() });
    try {
      queue.updateJob(job.id, { status: "queued", message: "创建上传会话", transferProgress: 0 });
      const result = await runImportAttempt({
        queue,
        job,
        controller,
        createInput: {
          ...job.draft,
          mode: "upload",
          theme: normalizeTheme(job.draft.theme),
          author: normalizeAuthor(job.draft.author),
          size: job.file.size,
          idempotency_key: attemptKey,
          storage_slug: job.storageSlug,
          batch_time: job.batchTime,
          manifest_position: job.manifestPosition
        },
        onSession: (session) => queue.updateJob(job.id, { sessionId: session.id }),
        transfer: async (session) => {
          queue.updateJob(job.id, { status: "uploading", message: "浏览器上传原文件", transferProgress: 0 });
          const request = uploadLocalRaw(session, job.file!, {
            onProgress: (transferProgress) => {
              if (isCurrentImportAttempt(queue, job.id, attemptKey)) queue.updateJob(job.id, { transferProgress });
            },
            onUploaded: () => {
              if (isCurrentImportAttempt(queue, job.id, attemptKey)) {
                queue.updateJob(job.id, { status: "processing", message: "上传完成，等待服务端处理", transferProgress: undefined });
              }
            }
          });
          // XHR 才能提供上传进度；取消时同时中断会话请求和文件传输。
          activeRequests.current.set(job.id, {
            attemptKey,
            abort: () => {
              controller.abort();
              request.abort();
            }
          });
          await request.promise;
        },
        onPreparing: () => {
          activeRequests.current.set(job.id, { attemptKey, abort: () => controller.abort() });
          queue.updateJob(job.id, { status: "processing", message: "上传完成，等待服务端处理", transferProgress: undefined });
        }
      });
      if (!result) return;
      if (result.acceptance.status === "duplicate") {
        await cancelStoredImport(result.session.id).catch(() => undefined);
        if (isCurrentImportAttempt(queue, job.id, attemptKey)) {
          queue.updateJob(job.id, { status: "cancelled", message: "批次内最终文件重复，已取消" });
        }
      }
    } catch (error) {
      applyImportAttemptFailure(queue, job.id, attemptKey, error);
    } finally {
      if (activeRequests.current.get(job.id)?.attemptKey === attemptKey) activeRequests.current.delete(job.id);
    }
  }, [queue]);

  const addFiles = useCallback(async (files: FileList | null) => {
    const existing = new Set(queue.jobsRef.current.map((job) => job.fileFingerprint).filter(Boolean));
    const selected = Array.from(files ?? []).filter(isUploadableImage).filter((file) => {
      // 新选择的文件也纳入 existing，避免一次选择框里重复文件生成两张任务卡。
      const fingerprint = fileFingerprint(file);
      if (existing.has(fingerprint)) return false;
      existing.add(fingerprint);
      return true;
    });
    if (selected.length > maxItems) {
      window.alert(`单次最多允许 ${maxItems} 个本地文件，请拆分后再导入`);
      return;
    }
    const batchTime = new Date().toISOString();
    const jobs = await Promise.all(selected.map(async (file, manifestPosition): Promise<ImportJob> => {
      const objectUrl = URL.createObjectURL(file);
      const inferred = await draftFromFile(file, defaults, objectUrl);
      return {
        id: browserUuid(),
        attemptKey: browserUuid(),
        batchTime,
        manifestPosition,
        kind: "local",
        file,
        fileFingerprint: fileFingerprint(file),
        status: file.size > maxBytes ? "failed" : "queued",
        message: file.size > maxBytes ? "图片大小超过限制" : "等待上传",
        preview: objectUrl,
        objectUrl,
        draft: inferred.draft,
        width: inferred.width,
        height: inferred.height,
        originalWidth: inferred.width,
        originalHeight: inferred.height,
        transferProgress: 0,
        duplicates: [],
        duplicateDecision: "upload",
        storageSlug,
        originalSize: file.size
      };
    }));
    queue.appendJobs(jobs);
    void runWithConcurrency(jobs.filter((job) => job.status === "queued"), concurrency, prepare);
  }, [concurrency, defaults, maxBytes, maxItems, prepare, queue, storageSlug]);

  const cancel = useCallback(async (job: ImportJob) => {
    activeRequests.current.get(job.id)?.abort();
    queue.updateJob(job.id, { status: "cancelled", message: "已取消" });
    if (job.sessionId) await cancelStoredImport(job.sessionId).catch(() => undefined);
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    if (!job.file) return;
    if (job.sessionId) await cancelStoredImport(job.sessionId).catch(() => undefined);
    queue.releasePreparedMd5(job.id);
    const next = { ...retryPrepareJob(job), transferProgress: 0 };
    queue.updateJob(job.id, next);
    await prepare(next);
  }, [prepare, queue]);

  return { addFiles, cancel, retry };
}
