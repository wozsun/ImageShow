import { useCallback, useEffect, useRef } from "react";
import type { ImportJob } from "../../../../lib/types.js";
import { isApiClientError } from "../../../../lib/api/client.js";
import {
  normalizeAuthor,
  normalizeTheme,
  type ImportAttributeDefaults
} from "../../../../lib/upload/upload-utils.js";
import {
  filterNewDownloadImportJobs,
  linkImportJobs,
  retryLinkPrepareJob
} from "../import-job-utils.js";
import { isCurrentImportAttempt, type AppendImportQueueApi } from "../prepared-result.js";
import {
  cancelStoredImport,
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
      pipeline.dispose();
      const sessionIds = queue.jobsRef.current
        .filter((job) => job.kind === "download" && job.sessionId)
        .filter((job) => !["done", "cancelled"].includes(job.status))
        .map((job) => job.sessionId!);
      for (const sessionId of new Set(sessionIds)) {
        void cancelStoredImport(sessionId).catch(() => undefined);
      }
    };
  }, [pipeline, queue]);

  const pipelineTask = useCallback((
    job: ImportJob
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
          queue.updateJob(job.id, {
            status: "queued",
            message: "创建下载会话"
          });
          return await materializeImportAttempt({
            queue,
            job,
            controller,
            createInput: linkSessionInput(job),
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
        await prepareMaterializedImportAttempt({
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
    jobs: ImportJob[]
  ) => {
    const acceptedJobs = filterNewDownloadImportJobs(queue.jobsRef.current, jobs);
    queue.appendJobs(acceptedJobs);
    if (!acceptedJobs.length) return;
    for (const job of acceptedJobs) {
      queue.updateJob(job.id, { status: "queued", message: "等待下载" });
    }
    void pipeline.enqueue(acceptedJobs.map(pipelineTask));
  }, [pipeline, pipelineTask, queue]);

  const addUrls = useCallback(async (urls: string[]) => {
    const jobs = linkImportJobs(urls, defaults, fillOriginalUrl, storageSlug);
    await addBatch(jobs);
  }, [addBatch, defaults, fillOriginalUrl, storageSlug]);

  const addJobs = useCallback(async (jobs: ImportJob[]) => {
    await addBatch(jobs);
  }, [addBatch]);

  const addWeiboJobs = useCallback(async (jobs: ImportJob[]) => {
    await addBatch(jobs);
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
