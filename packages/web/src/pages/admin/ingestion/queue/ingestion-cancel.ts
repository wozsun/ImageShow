import {
  ingestionBatchHardLimit,
  ingestionStatusBatchMaxItems,
  type IngestionCancelItemResultDto,
  type IngestionSessionPairDto
} from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../lib/types.js";
import {
  completedIngestionObservations,
  type IngestionQueueApi
} from "./ingestion-queue-api.js";
import {
  cancelStoredIngestions,
  getIngestionStatuses
} from "./ingestion-api.js";

type CancelTarget = Readonly<{
  id: string;
  attemptKey: string;
  pair: IngestionSessionPairDto;
  expectedVersion?: number;
}>;

export type IngestionQueueCancelOutcome = Readonly<{
  succeeded: boolean;
  pair?: IngestionSessionPairDto;
  terminal?: "completed" | "resolving";
}>;

function pairFor(job: IngestionJob) {
  return job.sessionId && job.imageId
    ? { session_id: job.sessionId, image_id: job.imageId }
    : null;
}

function currentAttempt(queue: IngestionQueueApi, target: {
  id: string;
  attemptKey: string;
}) {
  return queue.jobsRef.current.find((item) => (
    item.id === target.id && item.attemptKey === target.attemptKey
  ));
}

function markCancelFailure(
  queue: IngestionQueueApi,
  target: { id: string; attemptKey: string },
  message: string
) {
  const current = currentAttempt(queue, target);
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
  const current = currentAttempt(queue, target);
  if (result?.status === "completed") {
    queue.observeCompletedIngestions([{
      pair: target.pair,
      item: result.completed_item
    }]);
  }
  if (result?.status === "discarded") {
    if (current) {
      queue.updateJob(current.id, { status: "cancelled", message: "已取消" });
    }
    return { succeeded: true, pair: target.pair } satisfies IngestionQueueCancelOutcome;
  }
  if (result?.status === "completed" || result?.status === "resolving") {
    if (current) {
      queue.updateJob(current.id, {
        status: result.status === "completed" ? "finalized" : "committing",
        resultState: "recovering",
        message: result.status === "completed"
          ? "图片已写入图库，无法取消"
          : "数据库提交已经开始，正在确认最终结果"
      });
    }
    return {
      succeeded: false,
      pair: target.pair,
      terminal: result.status
    } satisfies IngestionQueueCancelOutcome;
  }
  markCancelFailure(
    queue,
    target,
    result?.message || "服务端未确认取消结果"
  );
  return { succeeded: false, pair: target.pair } satisfies IngestionQueueCancelOutcome;
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
    outcomes.set(job.id, { succeeded: false, pair: jobPair });
    const mounted = currentAttempt(queue, job);
    const current = mounted ?? (
      options.allowDetached && pairFor(job) ? job : null
    );
    if (!current) continue;
    if (current.status === "cancelled") {
      outcomes.set(job.id, { succeeded: true, pair: jobPair });
      continue;
    }
    if (["done", "finalized"].includes(current.status)) continue;
    if (mounted) {
      abort?.(current);
      queue.updateJob(current.id, {
        status: "cancelling",
        failureStage: undefined,
        message: "正在取消内容接入任务"
      });
    }
    const pair = pairFor(current);
    if (!pair) {
      if (options.allowUnacceptedUpload && current.kind === "upload") {
        queue.updateJob(current.id, { status: "cancelled", message: "已取消" });
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
      expectedVersion: current.serverVersion
    });
  }

  const ready = targets.filter((target) => target.expectedVersion !== undefined);
  const unknown = targets.filter((target) => target.expectedVersion === undefined);
  for (
    let offset = 0;
    offset < unknown.length;
    offset += ingestionStatusBatchMaxItems
  ) {
    const chunk = unknown.slice(offset, offset + ingestionStatusBatchMaxItems);
    try {
      const statuses = await getIngestionStatuses(chunk.map((target) => target.pair));
      queue.observeCompletedIngestions(completedIngestionObservations(statuses));
      for (const [index, target] of chunk.entries()) {
        const status = statuses[index];
        const current = currentAttempt(queue, target);
        if (!status || status.status === "missing") {
          markCancelFailure(
            queue,
            target,
            "服务端尚未确认任务已取消，请稍后重试"
          );
          continue;
        }
        if (status.status === "completed") {
          if (
            status.redis_status !== "missing"
            && status.redis_version !== undefined
          ) {
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
              resultState: "recovering",
              message: "图片已写入图库，无法取消"
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

  for (
    let offset = 0;
    offset < ready.length;
    offset += ingestionBatchHardLimit
  ) {
    const chunk = ready.slice(offset, offset + ingestionBatchHardLimit);
    try {
      const response = await cancelStoredIngestions(chunk.map((target) => ({
        ...target.pair,
        expected_version: target.expectedVersion!
      })));
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

export async function cancelServerIngestionJob(
  queue: IngestionQueueApi,
  job: IngestionJob,
  abort?: () => void,
  options: {
    allowDetached?: boolean;
    allowUnacceptedUpload?: boolean;
  } = {}
) {
  const outcomes = await cancelServerIngestionJobs(
    queue,
    [job],
    abort ? () => abort() : undefined,
    options
  );
  return outcomes.get(job.id)?.succeeded ?? false;
}
