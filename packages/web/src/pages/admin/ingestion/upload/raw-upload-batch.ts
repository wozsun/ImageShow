import type { RefObject } from "react";
import type { IngestionSessionPairDto } from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../lib/types.js";
import { uploadRaw } from "../queue/ingestion-api.js";
import {
  isCurrentIngestionAttempt,
  type IngestionQueueProducerApi
} from "../queue/ingestion-queue-api.js";
import { BrowserUploadLane } from "./browser-upload-lane.js";

export type ActiveRawUpload = {
  attemptKey: string;
  abort: () => void;
  settled: Promise<void>;
};

export type UploadCancellationOutcome = {
  attemptKey: string;
  status: "accepted" | "completed" | "discarded";
  pair?: IngestionSessionPairDto;
  target?: IngestionJob;
};

export async function runRawUploadBatch({
  uploads,
  browserLane,
  queue,
  mounted,
  activeUploads,
  cancellationOutcomes
}: {
  uploads: Array<Readonly<{ job: IngestionJob; credential: string }>>;
  browserLane: BrowserUploadLane;
  queue: IngestionQueueProducerApi;
  mounted: RefObject<boolean>;
  activeUploads: RefObject<Map<string, ActiveRawUpload>>;
  cancellationOutcomes: RefObject<Map<string, UploadCancellationOutcome>>;
}) {
  await Promise.all(uploads.map(async ({ job, credential }) => {
    if (
      !job.file
      || !mounted.current
      || !isCurrentIngestionAttempt(queue, job.id, job.attemptKey)
    ) return;
    const controller = new AbortController();
    let request: ReturnType<typeof uploadRaw> | null = null;
    const operation = browserLane.run(controller.signal, async () => {
      if (
        !job.file
        || !mounted.current
        || !isCurrentIngestionAttempt(queue, job.id, job.attemptKey)
      ) return;
      const rawConnectionGeneration =
        queue.captureServerConnectionGeneration();
      request = uploadRaw(credential, job.file, {
        onProgress: (transferProgress) => {
          if (isCurrentIngestionAttempt(queue, job.id, job.attemptKey)) {
            queue.updateJob(job.id, { transferProgress });
          }
        }
      });
      const accepted = await request.promise;
      const current = queue.jobsRef.current.find((item) => (
        item.id === job.id && item.attemptKey === job.attemptKey
      ));
      if (!current) return;
      const cancelling = current.status === "cancelling";
      if (!cancelling && !isCurrentIngestionAttempt(
        queue,
        job.id,
        job.attemptKey
      )) return;
      if (cancelling) {
        cancellationOutcomes.current.set(job.id, {
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
            message: "正在取消上传",
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
          ? "正在取消上传"
          : "上传已接收，等待服务器处理",
        transferProgress: 100
      }, rawConnectionGeneration, accepted.accepted_order);
    });
    const settled = operation.then(
      () => undefined,
      () => undefined
    );
    const activeUpload: ActiveRawUpload = {
      attemptKey: job.attemptKey,
      abort: () => {
        controller.abort();
        request?.abort();
      },
      settled
    };
    activeUploads.current.set(job.id, activeUpload);
    try {
      await operation;
    } catch (error) {
      if (
        mounted.current
        && isCurrentIngestionAttempt(queue, job.id, job.attemptKey)
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
  }));
}
