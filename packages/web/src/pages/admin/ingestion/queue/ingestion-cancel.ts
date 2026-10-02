import {
  ingestionBatchHardLimit,
  ingestionStatusBatchMaxItems,
  type ImportAcceptItemDto,
  type IngestionCancelItemResultDto,
  type IngestionQueueSummaryDto,
  type ServerIngestionStatusDto,
  type IngestionSessionPairDto,
  type UploadIntentItemDto
} from "@imageshow/shared/browser";
import {
  ingestionAcceptanceBinding,
  type AcceptedIngestionResult
} from "./model/acceptance-binding.js";
import { findIngestionAttempt, type IngestionJob } from "./model/ingestion-job.js";
import {
  completedIngestionObservations,
  type IngestionQueueProducerApi,
  type IngestionQueueApi
} from "./ingestion-queue-contract.js";
import {
  cancelStoredIngestions,
  getIngestionStatuses
} from "./ingestion-http-client.js";
import { ingestionStatusSummary } from "./model/ingestion-status-summary.js";

type CancelTarget = Readonly<{
  id: string;
  attemptKey: string;
  pair: IngestionSessionPairDto;
  expectedVersion?: number;
  releasedSummary?: IngestionQueueSummaryDto;
}>;

export type IngestionQueueCancelOutcome = Readonly<{
  succeeded: boolean;
  pair?: IngestionSessionPairDto;
  terminal?: "completed" | "resolving";
  releasedRevision?: number;
  releasedSummary?: IngestionQueueSummaryDto;
}>;

export function bindTerminalAcceptanceForCancellation(
  queue: IngestionQueueProducerApi,
  jobId: string,
  result: AcceptedIngestionResult,
  connectionGeneration: number | null
): IngestionQueueCancelOutcome | null {
  if (result.status === "accepted") return null;
  const discarded = result.status === "discarded";
  queue.bindServerJob(
    jobId,
    {
      ...ingestionAcceptanceBinding(result),
      status: discarded ? "cancelled" : "finalized",
      failureStage: undefined,
      ...(discarded ? {} : { resultState: "recovering" as const })
    },
    connectionGeneration,
    result.accepted_order
  );
  return {
    succeeded: discarded,
    pair: { session_id: result.session_id, image_id: result.image_id },
    ...(discarded ? {} : { terminal: "completed" as const })
  };
}

function releasedServerStatus(job: IngestionJob): ServerIngestionStatusDto | null {
  if (job.serverStatus && job.serverStatus !== "missing") {
    return job.serverStatus;
  }
  const statusByClient: Partial<Record<IngestionJob["status"], ServerIngestionStatusDto>> = {
    queued: "queued",
    uploading: "received",
    downloading: "downloading",
    received: "received",
    processing: "preparing",
    ready: "ready",
    "commit-queued": "ready",
    committing: "committing",
    finalized: "resolving",
    done: "completed",
    failed: "failed"
  };
  return statusByClient[job.status] ?? null;
}

function releasedSummaryForJob(job: IngestionJob): IngestionQueueSummaryDto | undefined {
  const status = releasedServerStatus(job);
  if (!status) return undefined;
  return ingestionStatusSummary(
    status,
    Boolean(job.duplicateCount || job.duplicates.length) && job.duplicateDecision === "undecided",
    job.serverPhase === "prepare-waiting"
  );
}

function pairFor(job: IngestionJob) {
  return job.sessionId && job.imageId
    ? { session_id: job.sessionId, image_id: job.imageId }
    : null;
}

function markCancelFailure(
  queue: IngestionQueueApi,
  target: { id: string; attemptKey: string },
  message: string
) {
  const current = findIngestionAttempt(queue.jobsRef.current, target);
  if (!current) return;
  queue.updateJob(current.id, {
    status: "failed",
    failureStage: "cancel",
    message
  });
}

function applyCancelResult(
  queue: IngestionQueueApi,
  target: CancelTarget,
  result: IngestionCancelItemResultDto | undefined
) {
  const current = findIngestionAttempt(queue.jobsRef.current, target);
  const releaseContext = target.releasedSummary
    ? { releasedSummary: target.releasedSummary }
    : {};
  if (result?.status === "completed") {
    queue.observeCompletedIngestions([
      {
        pair: target.pair,
        item: result.completed_item
      }
    ]);
  }
  if (result?.status === "discarded") {
    if (current) {
      queue.updateJob(current.id, { status: "cancelled", failureStage: undefined });
    }
    return {
      succeeded: true,
      pair: target.pair,
      releasedRevision: result.queue_revision,
      ...releaseContext
    } satisfies IngestionQueueCancelOutcome;
  }
  if (result?.status === "completed" || result?.status === "resolving") {
    if (current) {
      queue.updateJob(current.id, {
        status: result.status === "completed" ? "finalized" : "committing",
        failureStage: undefined,
        resultState: "recovering"
      });
    }
    return {
      succeeded: false,
      pair: target.pair,
      terminal: result.status,
      ...releaseContext
    } satisfies IngestionQueueCancelOutcome;
  }
  markCancelFailure(
    queue,
    target,
    result?.message || "服务端未确认取消结果"
  );
  return {
    succeeded: false,
    pair: target.pair,
    ...releaseContext
  } satisfies IngestionQueueCancelOutcome;
}

type AcceptanceReplayItem = ImportAcceptItemDto | UploadIntentItemDto;

/**
 * Replays the original acceptance request for jobs that never received a
 * server identity, so cancellation learns whether the server already owns
 * them. Unconfirmed results stay on the job as a cancel failure; accepted
 * jobs are bound as cancelling and returned for the stored-job cancel pass.
 */
export async function replayAcceptanceForCancellation(
  queue: IngestionQueueProducerApi,
  jobs: readonly IngestionJob[],
  outcomes: Map<string, IngestionQueueCancelOutcome>,
  source: Readonly<{
    maxItems: number;
    request: (chunk: IngestionJob[]) => Promise<readonly AcceptanceReplayItem[]>;
  }>
) {
  const cancellable: IngestionJob[] = [];
  for (let offset = 0; offset < jobs.length; offset += source.maxItems) {
    const chunk = jobs.slice(offset, offset + source.maxItems);
    const requestConnectionGeneration = queue.captureServerConnectionGeneration();
    let results: readonly AcceptanceReplayItem[];
    try {
      results = await source.request(chunk);
    } catch (error) {
      const message = `取消结果暂时无法确认：${
        error instanceof Error ? error.message : String(error)
      }`;
      for (const job of chunk) markCancelFailure(queue, job, message);
      continue;
    }
    for (const [index, job] of chunk.entries()) {
      const result = results[index];
      const current = findIngestionAttempt(queue.jobsRef.current, job);
      if (!current) continue;
      if (!result || result.status === "failed") {
        markCancelFailure(
          queue,
          current,
          result?.message ?? "服务端是否已接管任务暂时无法确认，请重试取消"
        );
        continue;
      }
      // An upload intent was never taken over by the server.
      if (result.status === "intent") {
        queue.updateJob(current.id, { status: "cancelled", failureStage: undefined });
        outcomes.set(current.id, { succeeded: true });
        continue;
      }
      const terminal = bindTerminalAcceptanceForCancellation(
        queue,
        current.id,
        result,
        requestConnectionGeneration
      );
      if (terminal) {
        outcomes.set(current.id, terminal);
        continue;
      }
      const binding = ingestionAcceptanceBinding(result);
      const cancelling = {
        status: "cancelling",
        failureStage: undefined
      } as const;
      queue.bindServerJob(
        current.id,
        { ...binding, ...cancelling },
        requestConnectionGeneration,
        result.accepted_order
      );
      cancellable.push(
        findIngestionAttempt(queue.jobsRef.current, current) ?? { ...current, ...binding, ...cancelling }
      );
    }
  }
  return cancellable;
}

/**
 * Cancel a frozen set through bounded status and cancel batches. Unknown
 * outcomes stay on their original attempt so a later explicit retry can
 * safely replay the same pair/version instead of assuming deletion.
 */
export async function cancelServerIngestionJobs(
  queue: IngestionQueueApi,
  jobs: readonly IngestionJob[],
  abort?: (job: IngestionJob) => void,
  options: {
    allowDetached?: boolean;
    allowUnacceptedUpload?: boolean;
  } = {}
) {
  const outcomes = new Map<string, IngestionQueueCancelOutcome>();
  const targets: CancelTarget[] = [];
  const seenAttempts = new Set<string>();
  for (const job of jobs) {
    const attempt = `${job.id}\0${job.attemptKey}`;
    if (seenAttempts.has(attempt)) continue;
    seenAttempts.add(attempt);
    const jobPair = pairFor(job) ?? undefined;
    const releasedSummary = releasedSummaryForJob(job);
    outcomes.set(job.id, {
      succeeded: false,
      pair: jobPair,
      ...(releasedSummary ? { releasedSummary } : {})
    });
    const mounted = findIngestionAttempt(queue.jobsRef.current, job);
    const current = mounted ?? (
      options.allowDetached && pairFor(job) ? job : null
    );
    if (!current) continue;
    if (current.status === "cancelled") {
      outcomes.set(job.id, {
        succeeded: true,
        pair: jobPair,
        ...(releasedSummary ? { releasedSummary } : {})
      });
      continue;
    }
    if (["done", "finalized"].includes(current.status)) continue;
    if (mounted) {
      abort?.(current);
      queue.updateJob(current.id, {
        status: "cancelling",
        failureStage: undefined
      });
    }
    const pair = pairFor(current);
    if (!pair) {
      if (options.allowUnacceptedUpload && current.kind === "upload") {
        queue.updateJob(current.id, { status: "cancelled", failureStage: undefined });
        outcomes.set(current.id, { succeeded: true });
      } else {
        markCancelFailure(
          queue,
          current,
          "服务端是否已接管任务暂时无法确认，请重试取消"
        );
      }
      continue;
    }
    targets.push({
      id: current.id,
      attemptKey: current.attemptKey,
      pair,
      expectedVersion: current.serverVersion,
      ...(releasedSummary ? { releasedSummary } : {})
    });
  }

  const ready = targets.filter((target) => target.expectedVersion !== undefined);
  const unknown = targets.filter((target) => target.expectedVersion === undefined);
  for (let offset = 0; offset < unknown.length; offset += ingestionStatusBatchMaxItems) {
    const chunk = unknown.slice(offset, offset + ingestionStatusBatchMaxItems);
    try {
      const statuses = await getIngestionStatuses(chunk.map((target) => target.pair));
      queue.observeCompletedIngestions(completedIngestionObservations(statuses));
      for (const [index, target] of chunk.entries()) {
        const status = statuses[index];
        const current = findIngestionAttempt(queue.jobsRef.current, target);
        if (!status || status.status === "missing") {
          markCancelFailure(
            queue,
            target,
            "服务端尚未确认任务已取消，请稍后重试"
          );
          continue;
        }
        if (status.status === "completed") {
          if (status.redis_status !== "missing"
            && status.redis_version !== undefined) {
            if (current) {
              queue.updateJob(current.id, {
                serverVersion: status.redis_version
              });
            }
            ready.push({
              ...target,
              expectedVersion: status.redis_version
            });
            continue;
          }
          if (status.redis_status !== "missing") {
            markCancelFailure(
              queue,
              target,
              "服务端完成回执缺少可核对版本，请刷新后重试取消"
            );
            continue;
          }
          if (current) {
            queue.updateJob(current.id, {
              status: "finalized",
              failureStage: undefined,
              resultState: "recovering"
            });
          }
          outcomes.set(target.id, {
            succeeded: false,
            pair: target.pair,
            terminal: "completed"
          });
          continue;
        }
        if (current) {
          queue.updateJob(current.id, { serverVersion: status.item.version });
        }
        ready.push({ ...target, expectedVersion: status.item.version });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const target of chunk) markCancelFailure(queue, target, message);
    }
  }

  for (let offset = 0; offset < ready.length; offset += ingestionBatchHardLimit) {
    const chunk = ready.slice(offset, offset + ingestionBatchHardLimit);
    try {
      const response = await cancelStoredIngestions(
        chunk.map((target) => ({
          ...target.pair,
          expected_version: target.expectedVersion!
        }))
      );
      for (const [index, target] of chunk.entries()) {
        outcomes.set(target.id, applyCancelResult(
          queue,
          target,
          response.items[index]
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const target of chunk) markCancelFailure(queue, target, message);
    }
  }
  return outcomes;
}
