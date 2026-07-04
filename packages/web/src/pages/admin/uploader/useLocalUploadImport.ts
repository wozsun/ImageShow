import { useCallback, useRef } from "react";
import type { ImportJob } from "../../../lib/types.js";
import { browserUuid, draftFromFile, isUploadableImage, normalizeAuthor, normalizeTheme, runWithConcurrency, type CommonAttributes } from "../../../lib/upload/upload-utils.js";
import { retryPrepareJob } from "./import-job-utils.js";
import { applyPreparedResult, type AppendImportQueueApi } from "./prepared-result.js";
import { cancelStoredImport, createImportSession, prepareImportSession, uploadLocalRaw } from "./import-api.js";

function fileFingerprint(file: File) {
  // 这里只做浏览器内“同一文件重复选择”的快速去重；最终内容去重仍以服务端标准化后的 md5 为准。
  return [file.name, file.size, file.lastModified, file.webkitRelativePath || ""].join("\u0000");
}

export function useLocalUploadImport(options: {
  queue: AppendImportQueueApi;
  defaults: CommonAttributes;
  storageSlug: string;
  maxBytes: number;
  concurrency: number;
}) {
  const { queue, defaults, storageSlug, maxBytes, concurrency } = options;
  const activeRequests = useRef(new Map<string, () => void>());

  const prepare = useCallback(async (job: ImportJob) => {
    if (!job.file) return;
    try {
      const sessionId = job.stagingId || job.id;
      queue.updateJob(job.id, { stagingId: sessionId });
      queue.updateJob(job.id, { status: "queued", message: "创建上传会话", uploadProgress: 0 });
      const session = await createImportSession({
        ...job.draft,
        mode: "upload",
        theme: normalizeTheme(job.draft.theme),
        author: normalizeAuthor(job.draft.author),
        size: job.file.size,
        session_id: sessionId,
        idempotency_key: sessionId,
        storage_slug: job.storageSlug
      });
      queue.updateJob(job.id, { stagingId: session.id });
      queue.updateJob(job.id, { status: "uploading", message: "浏览器上传原文件", uploadProgress: 0 });
      const request = uploadLocalRaw(session, job.file, {
        onProgress: (uploadProgress) => queue.updateJob(job.id, { uploadProgress }),
        onUploaded: () => {
          queue.updateJob(job.id, { status: "processing", message: "上传完成，等待服务端处理", uploadProgress: 100 });
        }
      });
      // uploadLocalRaw 使用 XMLHttpRequest 才能拿到上传进度；这里保存 abort，取消按钮可中断仍在传输的请求。
      activeRequests.current.set(job.id, request.abort);
      await request.promise;
      activeRequests.current.delete(job.id);
      queue.updateJob(job.id, { status: "processing", message: "上传完成，等待服务端处理", uploadProgress: 100 });
      const prepared = await prepareImportSession(session);
      const accepted = await applyPreparedResult(queue, job.id, prepared);
      if (!accepted) {
        await cancelStoredImport(session.id).catch(() => undefined);
        queue.updateJob(job.id, { status: "cancelled", message: "批次内最终文件重复，已取消" });
      }
    } catch (error) {
      activeRequests.current.delete(job.id);
      const current = queue.jobsRef.current.find((item) => item.id === job.id);
      if (current?.status !== "cancelled") queue.updateJob(job.id, { status: "failed", failureStage: "prepare", message: (error as Error).message });
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
    const jobs = await Promise.all(selected.map(async (file): Promise<ImportJob> => {
      const objectUrl = URL.createObjectURL(file);
      const inferred = await draftFromFile(file, defaults, objectUrl);
      return {
        id: browserUuid(), kind: "local", file, fileFingerprint: fileFingerprint(file),
        status: file.size > maxBytes ? "failed" : "queued",
        message: file.size > maxBytes ? "图片大小超过限制" : "等待上传",
        preview: objectUrl, objectUrl, draft: inferred.draft, width: inferred.width,
        height: inferred.height, originalWidth: inferred.width, originalHeight: inferred.height,
        uploadProgress: 0, duplicates: [], duplicateDecision: "upload",
        storageSlug, originalSize: file.size
      };
    }));
    queue.appendJobs(jobs);
    void runWithConcurrency(jobs.filter((job) => job.status === "queued"), concurrency, prepare);
  }, [concurrency, defaults, maxBytes, prepare, queue, storageSlug]);

  const cancel = useCallback(async (job: ImportJob) => {
    activeRequests.current.get(job.id)?.();
    queue.updateJob(job.id, { status: "cancelled", message: "已取消" });
    await cancelStoredImport(job.stagingId || job.id).catch(() => undefined);
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    if (!job.file) return;
    if (job.stagingId) await cancelStoredImport(job.stagingId).catch(() => undefined);
    const next = { ...retryPrepareJob(job), uploadProgress: 0 };
    queue.updateJob(job.id, next);
    await prepare(next);
  }, [prepare, queue]);

  return { addFiles, cancel, retry };
}
