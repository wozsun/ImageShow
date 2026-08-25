import { useCallback, useEffect, useRef } from "react";
import {
  importBatchHardLimit,
  type ImportSessionPairDto
} from "@imageshow/shared/browser";
import type { ImportJob } from "../../../lib/types.js";
import {
  draftFromFile,
  isUploadableImage,
  normalizeAuthor,
  normalizeTheme,
  runWithConcurrency,
  webImportBatchKey,
  webUuidV7,
  type ImportAttributeDefaults
} from "../../../lib/upload/upload-utils.js";
import {
  cancelServerImportJobs,
  type ImportQueueCancelOutcome
} from "./import-cancel.js";
import {
  filterNewLocalImportFiles,
  isUnconfirmedLocalRawAttempt,
  localImportFileFingerprint,
  retryPrepareJob
} from "./import-job-utils.js";
import {
  createUploadIntents,
  uploadLocalRaw
} from "./import-api.js";
import {
  isCurrentImportAttempt,
  type AppendImportQueueApi
} from "./import-queue-api.js";

type ActiveUpload = {
  attemptKey: string;
  abort: () => void;
  settled: Promise<void>;
};

function localIntentInput(job: ImportJob, maxLongEdge: number) {
  if (!job.file) throw new Error("本地导入任务缺少图片文件");
  if (job.manifestPosition === undefined) {
    throw new Error("本地导入任务缺少批次位置");
  }
  if (job.uploadIntentInput?.idempotency_key === job.attemptKey) {
    return job.uploadIntentInput;
  }
  return {
    ...job.draft,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author),
    idempotency_key: job.attemptKey,
    batch_key: job.subscriptionBatchKey,
    storage_slug: job.storageSlug,
    batch_time: job.batchTime,
    manifest_position: job.manifestPosition,
    expected_size: job.file.size,
    max_long_edge: maxLongEdge
  };
}

export function useLocalUploadImport(options: {
  queue: AppendImportQueueApi;
  defaults: ImportAttributeDefaults;
  storageSlug: string;
  maxItems: number;
  maxBytes: number;
  maxLongEdge: number;
  concurrency: number;
}) {
  const {
    queue,
    defaults,
    storageSlug,
    maxItems,
    maxBytes,
    maxLongEdge,
    concurrency
  } = options;
  const activeUploads = useRef(new Map<string, ActiveUpload>());
  const intentControllers = useRef(new Set<AbortController>());
  const pendingIntents = useRef(new Map<string, {
    attemptKey: string;
    settled: Promise<void>;
  }>());
  const cancellationIntentOutcomes = useRef(new Map<string, {
    attemptKey: string;
    status: "accepted" | "completed" | "discarded";
    pair?: ImportSessionPairDto;
    target?: ImportJob;
  }>());
  const pendingFileFingerprints = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const uploads = activeUploads.current;
    const controllers = intentControllers.current;
    return () => {
      mounted.current = false;
      for (const request of uploads.values()) request.abort();
      uploads.clear();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      pendingIntents.current.clear();
      cancellationIntentOutcomes.current.clear();
      // Canonical tasks are server-owned. Only a real owner unmount (such as
      // leaving the image route) aborts an unconverted browser transfer;
      // merely hiding the workflow keeps it alive and never implicitly cancels.
    };
  }, []);

  const startIntentBatch = useCallback(async (jobs: ImportJob[]) => {
    const candidates = jobs.filter((job) => (
      job.file
      && mounted.current
      && isCurrentImportAttempt(queue, job.id, job.attemptKey)
    ));
    if (!candidates.length) return;
    const inputs = candidates.map((job) => localIntentInput(job, maxLongEdge));
    const controller = new AbortController();
    intentControllers.current.add(controller);
    let resolveIntentOwnership!: () => void;
    const intentSettled = new Promise<void>((resolve) => {
      resolveIntentOwnership = resolve;
    });
    let intentOwnershipSettled = false;
    const finishIntentOwnership = () => {
      if (intentOwnershipSettled) return;
      intentOwnershipSettled = true;
      for (const job of candidates) {
        const pending = pendingIntents.current.get(job.id);
        if (
          pending?.attemptKey === job.attemptKey
          && pending.settled === intentSettled
        ) pendingIntents.current.delete(job.id);
      }
      resolveIntentOwnership();
    };
    for (const job of candidates) {
      pendingIntents.current.set(job.id, {
        attemptKey: job.attemptKey,
        settled: intentSettled
      });
    }
    for (const [index, job] of candidates.entries()) {
      queue.updateJob(job.id, {
        uploadIntentInput: inputs[index],
        status: "queued",
        failureStage: undefined,
        message: "正在签发上传意图",
        transferProgress: 0
      });
    }
    let results: Awaited<ReturnType<typeof createUploadIntents>>["items"];
    const intentConnectionGeneration =
      queue.captureServerConnectionGeneration();
    try {
      results = (await createUploadIntents(
        { items: inputs },
        controller.signal
      )).items;
    } catch (error) {
      if (mounted.current && (error as Error).name !== "AbortError") {
        for (const job of candidates) {
          if (!isCurrentImportAttempt(queue, job.id, job.attemptKey)) continue;
          queue.updateJob(job.id, {
            status: "failed",
            failureStage: "create",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
      finishIntentOwnership();
      return;
    } finally {
      intentControllers.current.delete(controller);
    }

    const uploads: Array<{
      job: ImportJob;
      credential: string;
    }> = [];
    try {
      for (const [index, job] of candidates.entries()) {
        const result = results[index];
        const current = queue.jobsRef.current.find((item) => (
          item.id === job.id && item.attemptKey === job.attemptKey
        ));
        if (!current) continue;
        const cancelling = current.status === "cancelling";
        if (!result) {
          queue.updateJob(job.id, {
            status: "failed",
            failureStage: cancelling ? "cancel" : "create",
            message: "上传意图响应缺少当前任务"
          });
          continue;
        }
        if (result.status === "failed") {
          queue.updateJob(job.id, {
            status: "failed",
            failureStage: cancelling ? "cancel" : "create",
            message: result.message
          });
          continue;
        }
        if (result.status === "discarded") {
          if (cancelling) {
            cancellationIntentOutcomes.current.set(job.id, {
              attemptKey: job.attemptKey,
              status: "discarded",
              pair: {
                session_id: result.session_id,
                image_id: result.image_id
              }
            });
          }
          queue.bindServerJob(job.id, {
            sessionId: result.session_id,
            imageId: result.image_id,
            serverAccepted: true,
            imageTime: result.resolved_image_time,
            status: "cancelled",
            message: "该上传尝试已取消"
          }, intentConnectionGeneration, result.accepted_order);
          continue;
        }
        if (result.status === "completed") {
          if (cancelling) {
            cancellationIntentOutcomes.current.set(job.id, {
              attemptKey: job.attemptKey,
              status: "completed",
              pair: {
                session_id: result.session_id,
                image_id: result.image_id
              }
            });
          }
          queue.bindServerJob(job.id, {
            sessionId: result.session_id,
            imageId: result.image_id,
            serverAccepted: true,
            serverVersion: result.version,
            serverSemanticRevision: result.last_semantic_revision,
            serverHandoffPending: true,
            serverHandoffRevision: result.last_semantic_revision,
            imageTime: result.resolved_image_time,
            status: "finalized",
            resultState: "recovering",
            message: "图片已写入图库，正在读取结果"
          }, intentConnectionGeneration, result.accepted_order);
          continue;
        }
        if (result.status === "accepted") {
          if (cancelling) {
            cancellationIntentOutcomes.current.set(job.id, {
              attemptKey: job.attemptKey,
              status: "accepted",
              target: {
                ...current,
                sessionId: result.session_id,
                imageId: result.image_id,
                serverAccepted: true,
                serverVersion: result.version,
                serverSemanticRevision: result.last_semantic_revision,
                serverHandoffPending: true,
                serverHandoffRevision: result.last_semantic_revision,
                imageTime: result.resolved_image_time,
                status: "cancelling",
                message: "正在取消导入"
              }
            });
          }
          queue.bindServerJob(job.id, {
            sessionId: result.session_id,
            imageId: result.image_id,
            serverAccepted: true,
            serverVersion: result.version,
            serverSemanticRevision: result.last_semantic_revision,
            serverHandoffPending: true,
            serverHandoffRevision: result.last_semantic_revision,
            imageTime: result.resolved_image_time,
            status: cancelling ? "cancelling" : "received",
            message: cancelling ? "正在取消导入" : "服务器已接管上传任务"
          }, intentConnectionGeneration, result.accepted_order);
          continue;
        }
        if (result.status !== "intent") continue;
        if (cancelling) {
          cancellationIntentOutcomes.current.set(job.id, {
            attemptKey: job.attemptKey,
            status: "discarded"
          });
          queue.updateJob(job.id, { status: "cancelled", message: "已取消" });
          continue;
        }
        queue.updateJob(job.id, {
          sessionId: result.session_id,
          imageId: result.candidate_image_id,
          imageTime: result.resolved_image_time,
          status: "uploading",
          message: "上传原图中",
          transferProgress: 0
        });
        uploads.push({ job, credential: result.credential });
      }
    } finally {
      finishIntentOwnership();
    }

    await runWithConcurrency(uploads, concurrency, async ({ job, credential }) => {
      if (
        !job.file
        || !mounted.current
        || !isCurrentImportAttempt(queue, job.id, job.attemptKey)
      ) return;
      const rawConnectionGeneration =
        queue.captureServerConnectionGeneration();
      const request = uploadLocalRaw(credential, job.file, {
        onProgress: (transferProgress) => {
          if (isCurrentImportAttempt(queue, job.id, job.attemptKey)) {
            queue.updateJob(job.id, { transferProgress });
          }
        }
      });
      const settled = request.promise.then(
        () => undefined,
        () => undefined
      );
      const activeUpload: ActiveUpload = {
        attemptKey: job.attemptKey,
        abort: request.abort,
        settled
      };
      activeUploads.current.set(job.id, activeUpload);
      try {
        const accepted = await request.promise;
        const current = queue.jobsRef.current.find((item) => (
          item.id === job.id && item.attemptKey === job.attemptKey
        ));
        if (!current) return;
        const cancelling = current.status === "cancelling";
        if (!cancelling && !isCurrentImportAttempt(
          queue,
          job.id,
          job.attemptKey
        )) return;
        if (cancelling) {
          cancellationIntentOutcomes.current.set(job.id, {
            attemptKey: job.attemptKey,
            status: "accepted",
            target: {
              ...current,
              sessionId: accepted.session_id,
              imageId: accepted.image_id,
              serverAccepted: true,
              serverVersion: accepted.version,
              serverSemanticRevision: accepted.last_semantic_revision,
              serverHandoffPending: true,
              serverHandoffRevision: accepted.last_semantic_revision,
              status: "cancelling",
              message: "正在取消导入",
              transferProgress: 100
            }
          });
        }
        queue.bindServerJob(job.id, {
          sessionId: accepted.session_id,
          imageId: accepted.image_id,
          serverAccepted: true,
          serverVersion: accepted.version,
          serverSemanticRevision: accepted.last_semantic_revision,
          serverHandoffPending: true,
          serverHandoffRevision: accepted.last_semantic_revision,
          status: cancelling ? "cancelling" : "received",
          message: cancelling
            ? "正在取消导入"
            : "上传已接收，等待服务器处理",
          transferProgress: 100
        }, rawConnectionGeneration, accepted.accepted_order);
      } catch (error) {
        if (
          mounted.current
          && isCurrentImportAttempt(queue, job.id, job.attemptKey)
          && (error as Error).name !== "AbortError"
        ) {
          queue.updateJob(job.id, {
            status: "failed",
            failureStage: "prepare",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } finally {
        if (activeUploads.current.get(job.id) === activeUpload) {
          activeUploads.current.delete(job.id);
        }
      }
    });
  }, [concurrency, maxLongEdge, queue]);

  const startJobs = useCallback(async (jobs: ImportJob[]) => {
    // Credentials expire while raw bytes are still browser-owned. Sign only
    // the files that can enter the current upload lane immediately; the next
    // bounded group is signed after this group has settled.
    const signedBatchSize = Math.max(1, concurrency);
    for (let offset = 0; offset < jobs.length; offset += signedBatchSize) {
      if (!mounted.current) return;
      await startIntentBatch(jobs.slice(offset, offset + signedBatchSize));
    }
  }, [concurrency, startIntentBatch]);

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
    const fingerprints = selected.map(localImportFileFingerprint);
    fingerprints.forEach((value) => pendingFileFingerprints.current.add(value));
    const batchTime = new Date().toISOString();
    const subscriptionBatchKey = webImportBatchKey();
    try {
      const jobs = await Promise.all(selected.map(async (
        file,
        manifestPosition
      ): Promise<ImportJob> => {
        const objectUrl = URL.createObjectURL(file);
        const inferred = await draftFromFile(file, defaults, objectUrl);
        const tooLarge = file.size > maxBytes;
        const tooWide = Math.max(inferred.width, inferred.height) > maxLongEdge;
        return {
          id: webUuidV7(),
          attemptKey: webUuidV7(),
          subscriptionBatchKey,
          batchTime,
          manifestPosition,
          kind: "local",
          file,
          fileFingerprint: localImportFileFingerprint(file),
          status: tooLarge || tooWide ? "failed" : "queued",
          failureStage: tooLarge || tooWide ? "create" : undefined,
          message: tooLarge
            ? "图片大小超过限制"
            : tooWide
              ? "图片长边超过限制"
              : "等待上传",
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
          if (job.objectUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(job.objectUrl);
          }
        }
        return;
      }
      if (queue.appendJobs(jobs) === false) {
        for (const job of jobs) {
          if (job.objectUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(job.objectUrl);
          }
        }
        window.alert(
          `当前窗口待接管任务已达 ${importBatchHardLimit} 项，请稍后再添加`
        );
        return;
      }
      void startJobs(jobs.filter((job) => job.status === "queued"));
    } finally {
      fingerprints.forEach((value) => pendingFileFingerprints.current.delete(value));
    }
  }, [defaults, maxBytes, maxItems, maxLongEdge, queue, startJobs, storageSlug]);

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
    const pending = new Set<Promise<void>>();
    const active = new Set<Promise<void>>();
    for (const job of jobs) {
      const current = queue.jobsRef.current.find((item) => (
        item.id === job.id && item.attemptKey === job.attemptKey
      ));
      if (!current) continue;
      const intent = pendingIntents.current.get(current.id);
      if (intent?.attemptKey === current.attemptKey) {
        queue.updateJob(current.id, {
          status: "cancelling",
          failureStage: undefined,
          message: "正在取消导入"
        });
        pending.add(intent.settled);
      }
      const upload = activeUploads.current.get(current.id);
      if (upload?.attemptKey === current.attemptKey) {
        queue.updateJob(current.id, {
          status: "cancelling",
          failureStage: undefined,
          message: "正在取消导入"
        });
        upload.abort();
        active.add(upload.settled);
      }
    }
    for (const operation of pending) await operation;
    for (const operation of active) await operation;
    const replay: ImportJob[] = [];
    const cancellable: ImportJob[] = [];
    for (const job of jobs) {
      const ownerOutcome = cancellationIntentOutcomes.current.get(job.id);
      if (ownerOutcome?.attemptKey === job.attemptKey) {
        if (ownerOutcome.status === "discarded") {
          outcomes.set(job.id, {
            succeeded: true,
            pair: ownerOutcome.pair
          });
        }
        if (ownerOutcome.status === "completed") {
          outcomes.set(job.id, {
            succeeded: false,
            pair: ownerOutcome.pair,
            terminal: "completed"
          });
        }
        if (
          ownerOutcome.status === "accepted"
          && ownerOutcome.target
        ) cancellable.push(ownerOutcome.target);
        continue;
      }
      const current = queue.jobsRef.current.find((item) => (
        item.id === job.id && item.attemptKey === job.attemptKey
      ));
      if (!current) continue;
      if (current.status === "cancelled") {
        outcomes.set(current.id, {
          succeeded: true,
          ...(current.sessionId && current.imageId ? {
            pair: { session_id: current.sessionId, image_id: current.imageId }
          } : {})
        });
      } else if (["done", "finalized"].includes(current.status)) {
        outcomes.set(current.id, {
          succeeded: false,
          ...(current.sessionId && current.imageId ? {
            pair: { session_id: current.sessionId, image_id: current.imageId },
            terminal: "completed" as const
          } : {})
        });
      } else if (
        current.serverVersion === undefined
        && current.uploadIntentInput
      ) {
        replay.push(current);
      } else {
        cancellable.push(current);
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
      let results: Awaited<ReturnType<typeof createUploadIntents>>["items"];
      try {
        results = (await createUploadIntents({
          items: chunk.map((job) => job.uploadIntentInput!)
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
        if (result.status === "intent") {
          queue.updateJob(current.id, { status: "cancelled", message: "已取消" });
          outcomes.set(current.id, { succeeded: true });
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
        queue.bindServerJob(current.id, {
          ...binding,
          status: "cancelling",
          failureStage: undefined,
          message: "正在取消导入"
        }, requestConnectionGeneration, result.accepted_order);
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
      { allowDetached: true, allowUnacceptedLocal: true }
    );
    for (const [id, succeeded] of cancelled) outcomes.set(id, succeeded);
    for (const job of jobs) {
      const outcome = cancellationIntentOutcomes.current.get(job.id);
      if (outcome?.attemptKey === job.attemptKey) {
        cancellationIntentOutcomes.current.delete(job.id);
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
    let releasedServerOwner = false;
    if (!current?.file) return;
    const active = activeUploads.current.get(current.id);
    if (active?.attemptKey === current.attemptKey) {
      active.abort();
      await active.settled;
      if (activeUploads.current.get(current.id) === active) {
        activeUploads.current.delete(current.id);
      }
    }
    const latest = queue.jobsRef.current.find((item) => item.id === job.id);
    if (!latest?.file || latest.attemptKey !== current.attemptKey) return;
    current = latest;
    const replayUnconfirmedRaw = isUnconfirmedLocalRawAttempt(current);
    if (current.sessionId && current.imageId && !replayUnconfirmedRaw) {
      const cancelled = await cancel(current);
      if (!cancelled.succeeded) return;
      const cancelledCurrent = queue.jobsRef.current.find(
        (item) => item.id === current!.id
      );
      if (!cancelledCurrent?.file) return;
      if (cancelled.pair) {
        const released = queue.releaseResolvedServerJobs([{
          id: current.id,
          attemptKey: current.attemptKey,
          pair: cancelled.pair
        }]);
        if (!released.has(current.id)) {
          queue.server.refresh();
          return;
        }
        releasedServerOwner = true;
      }
      current = cancelledCurrent;
    }
    const file = current.file;
    if (!file) return;
    const reuseIntentAttempt = !current.serverVersion
      && Boolean(current.uploadIntentInput)
      && (
        current.failureStage === "create" || replayUnconfirmedRaw
      );
    const objectUrl = !releasedServerOwner
      && current.objectUrl?.startsWith("blob:")
      ? current.objectUrl
      : URL.createObjectURL(file);
    const next = {
      ...retryPrepareJob(current),
      // A raw response can be lost before the canonical exists. Replaying the
      // same upload intent is the only safe retry: it either returns the
      // already accepted canonical or reissues a credential for the same pair.
      attemptKey: reuseIntentAttempt
        ? current.attemptKey
        : webUuidV7(),
      uploadIntentInput: reuseIntentAttempt
        ? current.uploadIntentInput
        : undefined,
      preview: objectUrl,
      previewFull: undefined,
      objectUrl,
      width: current.originalWidth ?? current.width,
      height: current.originalHeight ?? current.height,
      originalSize: file.size,
      transferProgress: 0
    };
    if (releasedServerOwner) {
      if (queue.appendJobs([next]) === false) {
        if (next.objectUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(next.objectUrl);
        }
        window.alert(
          `当前窗口待接管任务已达 ${importBatchHardLimit} 项，请稍后再试`
        );
        return;
      }
    } else queue.updateJob(current.id, next);
    await startJobs([next]);
  }, [cancel, queue, startJobs]);

  return { addFiles, cancel, cancelMany, retry };
}
