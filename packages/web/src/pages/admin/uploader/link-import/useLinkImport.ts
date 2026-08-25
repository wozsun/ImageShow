import { useCallback, useEffect, useRef } from "react";
import {
  importBatchHardLimit,
  type ImportSessionPairDto
} from "@imageshow/shared/browser";
import type { ImportJob } from "../../../../lib/types.js";
import {
  normalizeAuthor,
  normalizeTheme,
  type ImportAttributeDefaults
} from "../../../../lib/upload/upload-utils.js";
import {
  cancelServerImportJobs,
  type ImportQueueCancelOutcome
} from "../import-cancel.js";
import {
  filterNewDownloadImportJobs,
  linkImportJobs,
  retryLinkPrepareJob
} from "../import-job-utils.js";
import { acceptRemoteImports } from "../import-api.js";
import type { AppendImportQueueApi } from "../import-queue-api.js";

function remoteInput(job: ImportJob) {
  if (!job.url) throw new Error("远程导入任务缺少来源 URL");
  if (job.manifestPosition === undefined) {
    throw new Error("远程导入任务缺少批次位置");
  }
  if (job.remoteAcceptInput?.idempotency_key === job.attemptKey) {
    return job.remoteAcceptInput;
  }
  return {
    ...job.draft,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author),
    idempotency_key: job.attemptKey,
    batch_key: job.subscriptionBatchKey,
    source_type: job.manifestSource ?? "url" as const,
    url: job.url,
    storage_slug: job.storageSlug,
    image_time: job.imageTime,
    batch_time: job.batchTime,
    manifest_position: job.manifestPosition,
    manifest_line: job.manifestLine
  };
}

export function useLinkImport(options: {
  queue: AppendImportQueueApi;
  defaults: ImportAttributeDefaults;
  fillOriginalUrl: boolean;
  storageSlug: string;
}) {
  const { queue, defaults, fillOriginalUrl, storageSlug } = options;
  const controllers = useRef(new Set<AbortController>());
  const pendingAccepts = useRef(new Map<string, Promise<void>>());
  const cancellationAcceptOutcomes = useRef(new Map<string, {
    attemptKey: string;
    status: "accepted" | "completed" | "discarded";
    pair?: ImportSessionPairDto;
    target?: ImportJob;
  }>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    return () => {
      mounted.current = false;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
      pendingAccepts.current.clear();
      cancellationAcceptOutcomes.current.clear();
      // Accepted canonical tasks continue on the server after this component
      // closes; unmount is never an implicit queue cancellation.
    };
  }, []);

  const startBatch = useCallback((jobs: ImportJob[]) => {
    if (!jobs.length) return Promise.resolve();
    const inputs = jobs.map(remoteInput);
    const controller = new AbortController();
    controllers.current.add(controller);
    for (const [index, job] of jobs.entries()) {
      queue.updateJob(job.id, {
        remoteAcceptInput: inputs[index],
        status: "queued",
        failureStage: undefined,
        message: "正在提交远程导入任务"
      });
    }
    const promise = (async () => {
      let results: Awaited<ReturnType<typeof acceptRemoteImports>>["items"];
      const requestConnectionGeneration =
        queue.captureServerConnectionGeneration();
      try {
        results = (await acceptRemoteImports(
          { items: inputs },
          controller.signal
        )).items;
      } catch (error) {
        if (mounted.current && (error as Error).name !== "AbortError") {
          for (const job of jobs) {
            const current = queue.jobsRef.current.find(
              (item) => item.id === job.id && item.attemptKey === job.attemptKey
            );
            if (!current || current.status === "cancelling") continue;
            queue.updateJob(job.id, {
              status: "failed",
              failureStage: "create",
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
        return;
      } finally {
        controllers.current.delete(controller);
      }

      for (const [index, job] of jobs.entries()) {
        const result = results[index];
        const current = queue.jobsRef.current.find(
          (item) => item.id === job.id && item.attemptKey === job.attemptKey
        );
        if (!current) continue;
        if (!result) {
          if (current.status !== "cancelling") {
            queue.updateJob(job.id, {
              status: "failed",
              failureStage: "create",
              message: "远程导入响应缺少当前任务"
            });
          }
          continue;
        }
        if (result.status === "failed") {
          if (current.status !== "cancelling") {
            queue.updateJob(job.id, {
              status: "failed",
              failureStage: "create",
              message: result.message
            });
          }
          continue;
        }
        const binding = {
          sessionId: result.session_id,
          imageId: result.image_id,
          imageTime: result.resolved_image_time,
          serverAccepted: true,
          ...(result.status === "accepted" ? {
            serverVersion: result.version,
            serverSemanticRevision: result.last_semantic_revision,
            serverHandoffPending: true,
            serverHandoffRevision: result.last_semantic_revision
          } : result.status === "completed" ? {
            serverVersion: result.version,
            serverSemanticRevision: result.last_semantic_revision,
            serverHandoffPending: true,
            serverHandoffRevision: result.last_semantic_revision
          } : {})
        };
        if (current.status === "cancelling") {
          if (result.status === "accepted") {
            cancellationAcceptOutcomes.current.set(job.id, {
              attemptKey: job.attemptKey,
              status: "accepted",
              target: {
                ...current,
                ...binding,
                status: "cancelling",
                message: "正在取消导入"
              }
            });
          } else if (
            result.status === "completed" || result.status === "discarded"
          ) {
            cancellationAcceptOutcomes.current.set(job.id, {
              attemptKey: job.attemptKey,
              status: result.status,
              pair: {
                session_id: result.session_id,
                image_id: result.image_id
              }
            });
          }
          if (result.status === "discarded") {
            queue.bindServerJob(job.id, {
              ...binding,
              status: "cancelled",
              failureStage: undefined,
              message: "已取消"
            }, requestConnectionGeneration, result.accepted_order);
          } else if (result.status === "completed") {
            queue.bindServerJob(job.id, {
              ...binding,
              status: "finalized",
              failureStage: undefined,
              resultState: "recovering",
              message: "图片已写入图库，无法取消"
            }, requestConnectionGeneration, result.accepted_order);
          } else {
            queue.bindServerJob(
              job.id,
              binding,
              requestConnectionGeneration,
              result.accepted_order
            );
          }
          continue;
        }
        if (result.status === "discarded") {
          queue.bindServerJob(job.id, {
            ...binding,
            status: "cancelled",
            message: "该导入尝试已取消"
          }, requestConnectionGeneration, result.accepted_order);
        } else if (result.status === "completed") {
          queue.bindServerJob(job.id, {
            ...binding,
            status: "finalized",
            resultState: "recovering",
            message: "图片已写入图库，正在读取结果"
          }, requestConnectionGeneration, result.accepted_order);
        } else {
          queue.bindServerJob(job.id, {
            ...binding,
            status: "queued",
            message: "等待服务器下载"
          }, requestConnectionGeneration, result.accepted_order);
        }
      }
    })().finally(() => {
      for (const job of jobs) {
        if (pendingAccepts.current.get(job.id) === promise) {
          pendingAccepts.current.delete(job.id);
        }
      }
    });
    for (const job of jobs) pendingAccepts.current.set(job.id, promise);
    return promise;
  }, [queue]);

  const addBatch = useCallback(async (jobs: ImportJob[]) => {
    const acceptedJobs = filterNewDownloadImportJobs(
      queue.jobsRef.current,
      jobs
    );
    if (queue.appendJobs(acceptedJobs) === false) {
      window.alert(
        `当前窗口待接管任务已达 ${importBatchHardLimit} 项，请稍后再添加`
      );
      return;
    }
    if (acceptedJobs.length) void startBatch(acceptedJobs);
  }, [queue, startBatch]);

  const addUrls = useCallback(async (urls: string[]) => {
    await addBatch(linkImportJobs(
      urls,
      defaults,
      fillOriginalUrl,
      storageSlug
    ));
  }, [addBatch, defaults, fillOriginalUrl, storageSlug]);

  const addJobs = useCallback((jobs: ImportJob[]) => addBatch(jobs), [addBatch]);
  const addWeiboJobs = useCallback(
    (jobs: ImportJob[]) => addBatch(jobs),
    [addBatch]
  );

  const cancelMany = useCallback(async (jobs: readonly ImportJob[]) => {
    const outcomes = new Map<string, ImportQueueCancelOutcome>(jobs.map((job) => [
      job.id,
      {
        succeeded: false,
        ...(job.sessionId && job.imageId ? {
          pair: { session_id: job.sessionId, image_id: job.imageId }
        } : {})
      }
    ]));
    const attempts = new Map(jobs.map((job) => [job.id, job.attemptKey]));
    const pending = new Set<Promise<void>>();
    for (const job of jobs) {
      const current = queue.jobsRef.current.find((item) => (
        item.id === job.id && item.attemptKey === job.attemptKey
      ));
      if (!current) continue;
      const accept = pendingAccepts.current.get(job.id);
      if (accept) {
        queue.updateJob(job.id, {
          status: "cancelling",
          failureStage: undefined,
          message: "正在取消导入"
        });
        pending.add(accept);
      }
    }
    // A whole remote batch shares one accept promise. Await each distinct
    // owner operation once instead of attaching N cancellation continuations.
    for (const operation of pending) {
      try {
        await operation;
      } catch {
        // The idempotent accept replay below resolves an unknown owner result.
      }
    }

    const replay: ImportJob[] = [];
    const cancellable: ImportJob[] = [];
    for (const [id, attemptKey] of attempts) {
      const acceptOutcome = cancellationAcceptOutcomes.current.get(id);
      if (acceptOutcome?.attemptKey === attemptKey) {
        if (acceptOutcome.status === "discarded") {
          outcomes.set(id, {
            succeeded: true,
            pair: acceptOutcome.pair
          });
        }
        if (acceptOutcome.status === "completed") {
          outcomes.set(id, {
            succeeded: false,
            pair: acceptOutcome.pair,
            terminal: "completed"
          });
        }
        if (
          acceptOutcome.status === "accepted"
          && acceptOutcome.target
        ) cancellable.push(acceptOutcome.target);
        continue;
      }
      const current = queue.jobsRef.current.find((item) => (
        item.id === id && item.attemptKey === attemptKey
      ));
      if (!current) continue;
      if (current.status === "cancelled") {
        outcomes.set(id, {
          succeeded: true,
          ...(current.sessionId && current.imageId ? {
            pair: { session_id: current.sessionId, image_id: current.imageId }
          } : {})
        });
      } else if (["done", "finalized"].includes(current.status)) {
        outcomes.set(id, {
          succeeded: false,
          ...(current.sessionId && current.imageId ? {
            pair: { session_id: current.sessionId, image_id: current.imageId },
            terminal: "completed" as const
          } : {})
        });
      } else if (current.sessionId && current.imageId) {
        cancellable.push(current);
      } else {
        replay.push(current);
      }
    }

    for (
      let offset = 0;
      offset < replay.length;
      offset += importBatchHardLimit
    ) {
      const chunk = replay.slice(offset, offset + importBatchHardLimit);
      const requestConnectionGeneration =
        queue.captureServerConnectionGeneration();
      let results: Awaited<ReturnType<typeof acceptRemoteImports>>["items"];
      try {
        results = (await acceptRemoteImports({
          items: chunk.map(remoteInput)
        })).items;
      } catch (error) {
        for (const job of chunk) {
          const current = queue.jobsRef.current.find((item) => (
            item.id === job.id && item.attemptKey === job.attemptKey
          ));
          if (!current) continue;
          queue.updateJob(current.id, {
            status: "failed",
            failureStage: "cancel",
            message: `取消结果暂时无法确认：${
              error instanceof Error ? error.message : String(error)
            }`
          });
        }
        continue;
      }
      for (const [index, job] of chunk.entries()) {
        const result = results[index];
        const current = queue.jobsRef.current.find((item) => (
          item.id === job.id && item.attemptKey === job.attemptKey
        ));
        if (!current) continue;
        if (!result || result.status === "failed") {
          queue.updateJob(current.id, {
            status: "failed",
            failureStage: "cancel",
            message: result?.message
              ?? "服务端是否已接管任务暂时无法确认，请重试取消"
          });
          continue;
        }
        const binding = {
          sessionId: result.session_id,
          imageId: result.image_id,
          imageTime: result.resolved_image_time,
          serverAccepted: true,
          ...(result.status === "accepted" || result.status === "completed"
            ? {
                serverVersion: result.version,
                serverSemanticRevision: result.last_semantic_revision,
                serverHandoffPending: true,
                serverHandoffRevision: result.last_semantic_revision
              }
            : {})
        };
        if (result.status === "discarded") {
          queue.bindServerJob(current.id, {
            ...binding,
            status: "cancelled",
            failureStage: undefined,
            message: "已取消"
          }, requestConnectionGeneration, result.accepted_order);
          outcomes.set(current.id, {
            succeeded: true,
            pair: {
              session_id: result.session_id,
              image_id: result.image_id
            }
          });
          continue;
        }
        if (result.status === "completed") {
          queue.bindServerJob(current.id, {
            ...binding,
            status: "finalized",
            failureStage: undefined,
            resultState: "recovering",
            message: "图片已写入图库，无法取消"
          }, requestConnectionGeneration, result.accepted_order);
          outcomes.set(current.id, {
            succeeded: false,
            pair: {
              session_id: result.session_id,
              image_id: result.image_id
            },
            terminal: "completed"
          });
          continue;
        }
        queue.bindServerJob(
          current.id,
          binding,
          requestConnectionGeneration,
          result.accepted_order
        );
        const bound = queue.jobsRef.current.find((item) => (
          item.id === current.id && item.attemptKey === current.attemptKey
        ));
        cancellable.push(bound ?? {
          ...current,
          ...binding,
          status: "cancelling",
          message: "正在取消导入"
        });
      }
    }

    const cancelled = await cancelServerImportJobs(
      queue,
      cancellable,
      undefined,
      { allowDetached: true }
    );
    for (const [id, succeeded] of cancelled) outcomes.set(id, succeeded);
    for (const [id, attemptKey] of attempts) {
      const outcome = cancellationAcceptOutcomes.current.get(id);
      if (outcome?.attemptKey === attemptKey) {
        cancellationAcceptOutcomes.current.delete(id);
      }
    }
    return outcomes;
  }, [queue]);

  const cancel = useCallback(async (job: ImportJob) => (
    (await cancelMany([job])).get(job.id) ?? {
      succeeded: false,
      ...(job.sessionId && job.imageId ? {
        pair: { session_id: job.sessionId, image_id: job.imageId }
      } : {})
    }
  ), [cancelMany]);

  const retry = useCallback(async (job: ImportJob) => {
    let current = queue.jobsRef.current.find((item) => item.id === job.id);
    if (!current) return;
    let releasedServerOwner = false;
    if (current.sessionId && current.imageId) {
      const outcome = (await cancelServerImportJobs(queue, [current])).get(current.id);
      if (outcome?.succeeded !== true) return;
      const cancelledCurrent = queue.jobsRef.current.find((item) => (
        item.id === current!.id && item.attemptKey === current!.attemptKey
      ));
      if (!cancelledCurrent) return;
      if (outcome.pair) {
        const released = queue.releaseResolvedServerJobs([{
          id: current.id,
          attemptKey: current.attemptKey,
          pair: outcome.pair
        }]);
        if (!released.has(current.id)) {
          queue.server.refresh();
          return;
        }
        releasedServerOwner = true;
      }
      current = cancelledCurrent;
    }
    const next = {
      ...retryLinkPrepareJob(current),
      preview: "",
      previewFull: undefined,
      objectUrl: undefined,
      width: 0,
      height: 0,
      originalWidth: undefined,
      originalHeight: undefined,
      originalSize: undefined
    };
    if (releasedServerOwner) {
      if (queue.appendJobs([next]) === false) {
        window.alert(
          `当前窗口待接管任务已达 ${importBatchHardLimit} 项，请稍后再试`
        );
        return;
      }
    } else queue.updateJob(current.id, next);
    await startBatch([next]);
  }, [queue, startBatch]);

  return { addUrls, addJobs, addWeiboJobs, cancel, cancelMany, retry };
}
