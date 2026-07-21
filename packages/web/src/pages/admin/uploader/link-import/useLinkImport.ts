import { useCallback, useEffect, useRef } from "react";
import type { ImportJob } from "../../../../lib/types.js";
import { isApiClientError } from "../../../../lib/api/client.js";
import {
  normalizeAuthor,
  normalizeTheme,
  type ImportAttributeDefaults
} from "../../../../lib/upload/upload-utils.js";
import { importPositionText, linkImportJobs, retryLinkPrepareJob } from "../import-job-utils.js";
import { batchDuplicateFromJob } from "../duplicate-match.js";
import { isCurrentImportAttempt, type AppendImportQueueApi } from "../prepared-result.js";
import {
  cancelStoredImport,
  createImportSessionsBatch,
  materializeImportSession,
  type ImportSessionCreateInput,
  type ImportSessionHandle
} from "../import-api.js";
import {
  applyImportAttemptFailure,
  cancelImportAttempt,
  materializeImportAttempt,
  prepareMaterializedImportAttempt
} from "../import-attempt.js";
import {
  MaterializationPipeline,
  type MaterializationPipelineTask
} from "../materialization-pipeline.js";

function linkSessionInput(job: ImportJob): ImportSessionCreateInput {
  return {
    ...job.draft,
    mode: "download",
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
  defaults: ImportAttributeDefaults;
  fillOriginalUrl: boolean;
  storageSlug: string;
  concurrency: number;
}) {
  const { queue, defaults, fillOriginalUrl, storageSlug, concurrency } = options;
  const controllers = useRef(new Map<string, AbortController>());
  const batchControllers = useRef(new Set<AbortController>());
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
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      for (const controller of batchControllers.current) controller.abort();
      batchControllers.current.clear();
      pipeline.dispose();
      const sessionIds = queue.jobsRef.current
        .filter((job) => job.kind === "download" && job.sessionId)
        .filter((job) => !["done", "skipped", "cancelled"].includes(job.status))
        .map((job) => job.sessionId!);
      for (const sessionId of new Set(sessionIds)) {
        void cancelStoredImport(sessionId).catch(() => undefined);
      }
    };
  }, [pipeline, queue]);

  const pipelineTask = useCallback((
    job: ImportJob,
    sessionSource?: () => Promise<ImportSessionHandle | null>
  ): MaterializationPipelineTask<ImportSessionHandle> => {
    const attemptKey = job.attemptKey;
    let controller: AbortController | undefined;
    let sessionId: string | undefined;
    let sessionCreated = false;
    let sessionKnown: Promise<string | undefined> | undefined;
    let resolveSessionKnown: ((id: string | undefined) => void) | undefined;
    return {
      materialize: async () => {
        if (!job.url || job.kind === "local" || !mounted.current
          || !isCurrentImportAttempt(queue, job.id, attemptKey)) {
          return null;
        }
        controller = new AbortController();
        sessionKnown = new Promise((resolve) => {
          resolveSessionKnown = resolve;
        });
        controllers.current.set(job.id, controller);
        try {
          const existingSession = sessionSource
            ? (await sessionSource() ?? undefined)
            : undefined;
          if (sessionSource && !existingSession) return null;
          if (!existingSession) {
            queue.updateJob(job.id, {
              status: "queued",
              message: "创建下载会话"
            });
          }
          return await materializeImportAttempt({
            queue,
            job,
            controller,
            createInput: linkSessionInput(job),
            session: existingSession,
            onSession: (session) => {
              sessionId = session.id;
              sessionCreated = true;
              resolveSessionKnown?.(session.id);
              resolveSessionKnown = undefined;
              queue.updateJob(job.id, {
                status: "downloading",
                message: "服务端下载原图",
                sessionId: session.id
              });
            },
            materialize: (session) => materializeImportSession(
              session,
              controller!.signal
            )
          });
        } finally {
          resolveSessionKnown?.(sessionId);
          resolveSessionKnown = undefined;
        }
      },
      prepare: async (session, startSuccessor) => {
        if (!controller) return;
        const result = await prepareMaterializedImportAttempt({
          queue,
          job,
          controller,
          session,
          startSuccessor,
          onPreparing: () => {
            queue.updateJob(job.id, {
              status: "processing",
              message: "下载完成，等待服务端处理"
            });
          }
        });
        if (!result) return;

        const applied = result.acceptance;
        const duplicateExists = result.prepared.duplicates.length > 0;
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
            const ownerPositionText = owner ? importPositionText(owner) : "";
            const batchDuplicate = !libraryDuplicate && owner
              ? batchDuplicateFromJob(owner)
              : undefined;
            queue.updateJob(job.id, {
              status: "skipped",
              message: libraryDuplicate
                ? `与图库中 ${duplicates.length} 张图片的最终文件重复，已跳过`
                : ownerPositionText
                  ? `与${ownerPositionText}的处理后文件重复，已跳过`
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
      },
      onError: (error) => {
        applyImportAttemptFailure(
          queue,
          job.id,
          attemptKey,
          error,
          sessionCreated || isApiClientError(error) ? "prepare" : "create"
        );
      },
      onDiscard: async () => {
        if (controllers.current.get(job.id) === controller) controller?.abort();
        const knownSessionId = sessionId ?? await sessionKnown;
        if (knownSessionId) await cancelStoredImport(knownSessionId).catch(() => undefined);
      },
      onSettled: () => {
        if (controllers.current.get(job.id) === controller) controllers.current.delete(job.id);
      }
    };
  }, [queue]);

  const addBatch = useCallback(async (
    jobs: ImportJob[],
    source: "urls" | "jsonl" | "weibo"
  ) => {
    queue.appendJobs(jobs);
    if (!jobs.length) return;
    for (const job of jobs) {
      queue.updateJob(job.id, { status: "queued", message: "批量创建导入会话" });
    }

    const controller = new AbortController();
    batchControllers.current.add(controller);
    const sessions = new Map<string, ImportSessionHandle | null>();
    const batchReady = createImportSessionsBatch(
      source,
      jobs.map(linkSessionInput),
      controller.signal
    ).then(async (results) => {
      const jobByAttempt = new Map(jobs.map((job) => [job.attemptKey, job] as const));
      const returnedAttempts = new Set<string>();
      for (const result of results) {
        returnedAttempts.add(result.idempotency_key);
        const job = jobByAttempt.get(result.idempotency_key);
        if (!job) {
          if (!("error" in result)) await cancelStoredImport(result.session.id).catch(() => undefined);
          continue;
        }
        if ("error" in result) {
          sessions.set(job.attemptKey, null);
          applyImportAttemptFailure(queue, job.id, job.attemptKey, new Error(result.error));
          continue;
        }
        sessions.set(job.attemptKey, result.session);
        if (!mounted.current || !isCurrentImportAttempt(queue, job.id, job.attemptKey)) {
          await cancelStoredImport(result.session.id).catch(() => undefined);
          continue;
        }
        queue.updateJob(job.id, { sessionId: result.session.id });
      }
      for (const job of jobs) {
        if (returnedAttempts.has(job.attemptKey)) continue;
        sessions.set(job.attemptKey, null);
        applyImportAttemptFailure(
          queue,
          job.id,
          job.attemptKey,
          new Error("服务端未返回导入会话结果"),
          "create"
        );
      }
    }, (error) => {
      const failureStage = isApiClientError(error) ? "prepare" : "create";
      for (const job of jobs) {
        sessions.set(job.attemptKey, null);
        if (mounted.current) {
          applyImportAttemptFailure(queue, job.id, job.attemptKey, error, failureStage);
        }
      }
    }).finally(() => {
      batchControllers.current.delete(controller);
    });

    void pipeline.enqueue(jobs.map((job) => pipelineTask(
      job,
      async () => {
        await batchReady;
        return sessions.get(job.attemptKey) ?? null;
      }
    )));
    await batchReady;
  }, [pipeline, pipelineTask, queue]);

  const addUrls = useCallback(async (urls: string[]) => {
    const jobs = linkImportJobs(urls, defaults, fillOriginalUrl, storageSlug);
    await addBatch(jobs, "urls");
  }, [addBatch, defaults, fillOriginalUrl, storageSlug]);

  const addJobs = useCallback(async (jobs: ImportJob[]) => {
    await addBatch(jobs, "jsonl");
  }, [addBatch]);

  const addWeiboJobs = useCallback(async (jobs: ImportJob[]) => {
    await addBatch(jobs, "weibo");
  }, [addBatch]);

  const cancel = useCallback(async (job: ImportJob) => {
    return cancelImportAttempt(
      queue,
      job,
      () => controllers.current.get(job.id)?.abort()
    );
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    if (job.sessionId) await cancelStoredImport(job.sessionId).catch(() => undefined);
    queue.releasePreparedMd5(job.id);
    // If create completed on the server but its response was lost, retry with
    // the same idempotency key so the existing session can be recovered.
    const next = {
      ...retryLinkPrepareJob(job),
      preview: "",
      previewFull: undefined,
      objectUrl: undefined,
      width: 0,
      height: 0,
      originalWidth: undefined,
      originalHeight: undefined,
      originalSize: undefined
    };
    queue.updateJob(job.id, next);
    await pipeline.enqueue([pipelineTask(next)]);
  }, [pipeline, pipelineTask, queue]);

  return { addUrls, addJobs, addWeiboJobs, cancel, retry };
}
