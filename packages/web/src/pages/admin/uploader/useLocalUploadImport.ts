import { useCallback, useEffect, useRef } from "react";
import type { ImportJob } from "../../../lib/types.js";
import {
  browserUuid,
  draftFromFile,
  isUploadableImage,
  normalizeAuthor,
  normalizeTheme,
  type ImportAttributeDefaults
} from "../../../lib/upload/upload-utils.js";
import {
  filterNewLocalImportFiles,
  localImportFileFingerprint,
  retryPrepareJob
} from "./import-job-utils.js";
import { isCurrentImportAttempt, type AppendImportQueueApi } from "./prepared-result.js";
import {
  cancelStoredImport,
  uploadLocalRaw,
  type ImportSessionHandle
} from "./import-api.js";
import {
  applyImportAttemptFailure,
  cancelImportAttempt,
  materializeImportAttempt,
  prepareMaterializedImportAttempt
} from "./import-attempt.js";
import {
  MaterializationPipeline,
  type MaterializationPipelineTask
} from "./materialization-pipeline.js";

export function useLocalUploadImport(options: {
  queue: AppendImportQueueApi;
  defaults: ImportAttributeDefaults;
  storageSlug: string;
  maxItems: number;
  maxBytes: number;
  concurrency: number;
}) {
  const { queue, defaults, storageSlug, maxItems, maxBytes, concurrency } = options;
  const activeRequests = useRef(new Map<string, { attemptKey: string; abort: () => void }>());
  const pendingFileFingerprints = useRef(new Set<string>());
  const mounted = useRef(true);
  const pipelineRef = useRef<MaterializationPipeline<ImportSessionHandle> | null>(null);
  if (!pipelineRef.current) {
    pipelineRef.current = new MaterializationPipeline<ImportSessionHandle>(concurrency);
  }
  const pipeline = pipelineRef.current;

  useEffect(() => {
    pipeline.setConcurrency(concurrency);
  }, [concurrency, pipeline]);

  useEffect(() => {
    mounted.current = true;
    pipeline.resume();
    return () => {
      mounted.current = false;
      for (const request of activeRequests.current.values()) request.abort();
      activeRequests.current.clear();
      pipeline.dispose();
      const sessionIds = queue.jobsRef.current
        .filter((job) => job.kind === "local" && job.sessionId)
        .filter((job) => !["done", "cancelled"].includes(job.status))
        .map((job) => job.sessionId!);
      for (const sessionId of new Set(sessionIds)) {
        void cancelStoredImport(sessionId).catch(() => undefined);
      }
    };
  }, [pipeline, queue]);

  const pipelineTask = useCallback((job: ImportJob): MaterializationPipelineTask<ImportSessionHandle> => {
    const attemptKey = job.attemptKey;
    let controller: AbortController | undefined;
    let sessionId: string | undefined;
    let sessionKnown: Promise<string | undefined> | undefined;
    let resolveSessionKnown: ((id: string | undefined) => void) | undefined;
    return {
      materialize: async () => {
        if (!job.file || !mounted.current || !isCurrentImportAttempt(queue, job.id, attemptKey)) {
          return null;
        }
        controller = new AbortController();
        sessionKnown = new Promise((resolve) => {
          resolveSessionKnown = resolve;
        });
        activeRequests.current.set(job.id, { attemptKey, abort: () => controller?.abort() });
        queue.updateJob(job.id, { status: "queued", message: "创建上传会话", transferProgress: 0 });
        try {
          return await materializeImportAttempt({
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
            onSession: (session) => {
              sessionId = session.id;
              resolveSessionKnown?.(session.id);
              resolveSessionKnown = undefined;
              queue.updateJob(job.id, { sessionId: session.id });
            },
            materialize: async (session) => {
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
                  controller?.abort();
                  request.abort();
                }
              });
              await request.promise;
            }
          });
        } finally {
          resolveSessionKnown?.(sessionId);
          resolveSessionKnown = undefined;
        }
      },
      prepare: async (session, startSuccessor) => {
        if (!controller) return;
        activeRequests.current.set(job.id, { attemptKey, abort: () => controller?.abort() });
        await prepareMaterializedImportAttempt({
          queue,
          job,
          controller,
          session,
          startSuccessor,
          onPreparing: () => {
            queue.updateJob(job.id, { status: "processing", message: "上传完成，等待服务端处理", transferProgress: undefined });
          }
        });
      },
      onError: (error) => {
        applyImportAttemptFailure(queue, job.id, attemptKey, error);
      },
      onDiscard: async () => {
        if (activeRequests.current.get(job.id)?.attemptKey === attemptKey) {
          activeRequests.current.get(job.id)?.abort();
        }
        const knownSessionId = sessionId ?? await sessionKnown;
        if (knownSessionId) await cancelStoredImport(knownSessionId).catch(() => undefined);
      },
      onSettled: () => {
        if (activeRequests.current.get(job.id)?.attemptKey === attemptKey) {
          activeRequests.current.delete(job.id);
        }
      }
    };
  }, [queue]);

  const enqueue = useCallback((job: ImportJob) => {
    return pipeline.enqueue([pipelineTask(job)]);
  }, [pipeline, pipelineTask]);

  const addFiles = useCallback(async (files: FileList | null) => {
    const selected = filterNewLocalImportFiles(
      queue.jobsRef.current,
      Array.from(files ?? []).filter(isUploadableImage),
      pendingFileFingerprints.current
    );
    if (selected.length > maxItems) {
      window.alert(`单次最多允许 ${maxItems} 张图片，请拆分后再导入`);
      return;
    }
    const selectedFingerprints = selected.map(localImportFileFingerprint);
    selectedFingerprints.forEach((fingerprint) => pendingFileFingerprints.current.add(fingerprint));
    const batchTime = new Date().toISOString();
    try {
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
          fileFingerprint: localImportFileFingerprint(file),
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
      if (!mounted.current) {
        for (const job of jobs) {
          if (job.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(job.objectUrl);
        }
        return;
      }
      queue.appendJobs(jobs);
      void pipeline.enqueue(
        jobs.filter((job) => job.status === "queued").map(pipelineTask)
      );
    } finally {
      selectedFingerprints.forEach((fingerprint) => pendingFileFingerprints.current.delete(fingerprint));
    }
  }, [defaults, maxBytes, maxItems, pipeline, pipelineTask, queue, storageSlug]);

  const cancel = useCallback(async (job: ImportJob) => {
    return cancelImportAttempt(
      queue,
      job,
      activeRequests.current.get(job.id)?.abort
    );
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    if (!job.file) return;
    if (job.sessionId) await cancelStoredImport(job.sessionId).catch(() => undefined);
    const objectUrl = job.objectUrl?.startsWith("blob:")
      ? job.objectUrl
      : URL.createObjectURL(job.file);
    const next = {
      ...retryPrepareJob(job),
      preview: objectUrl,
      previewFull: undefined,
      objectUrl,
      width: job.originalWidth ?? job.width,
      height: job.originalHeight ?? job.height,
      originalSize: job.file.size,
      transferProgress: 0
    };
    queue.updateJob(job.id, next);
    await enqueue(next);
  }, [enqueue, queue]);

  return { addFiles, cancel, retry };
}
