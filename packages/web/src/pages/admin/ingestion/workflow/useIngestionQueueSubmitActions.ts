import { useCallback } from "react";
import { ingestionBatchHardLimit, type IngestionSessionPairDto } from "@imageshow/shared/browser";
import { imageAttributeClearPatch, type PrepareImageAttributeClear } from "../../../../lib/image-draft.js";
import type { FrozenIngestionQueueAction } from "../queue/useIngestionQueueActions.js";
import type { IngestionJob } from "../../../../lib/types.js";
import type { IngestionAttributeDefaults } from "../queue/model/ingestion-attribute-defaults.js";
import { ingestionAttributeDefaultsActionMetadata } from "../queue/model/ingestion-attribute-policy.js";
import { ingestionJobCanStartCommit } from "../queue/model/ingestion-queue-state.js";
import type { IngestionQueueController } from "../queue/useIngestionQueue.js";
import type {
  CapturedServerAction
} from "./ingestion-workflow-action-model.js";

export function useIngestionQueueSubmitActions({
  queue,
  defaults,
  commitJobs,
  onDone,
  captureServerAction
}: {
  queue: IngestionQueueController;
  defaults: IngestionAttributeDefaults;
  commitJobs: (jobs: IngestionJob[]) => Promise<boolean>;
  onDone: () => void;
  captureServerAction: (
    action: Parameters<IngestionQueueController["actions"]["freeze"]>[0],
    required: boolean,
    metadata?: Parameters<IngestionQueueController["actions"]["freeze"]>[1]
  ) => CapturedServerAction;
}) {
  const applyDefaultsToQueue = useCallback(() => {
    const summary = queue.server.summary;
    const serverAction = captureServerAction(
      "apply_metadata",
      queue.server.status !== "ready"
        || !summary
        || summary.unfinished - summary.committing - summary.resolving > 0,
      ingestionAttributeDefaultsActionMetadata(defaults)
    );
    if (serverAction.required && !serverAction.frozen) {
      queue.server.refresh();
      return;
    }
    const localJobs = queue.captureBrowserActionJobs(() => true);
    queue.applyDefaultsToLocalJobs(defaults, localJobs);
    if (serverAction.frozen) {
      void queue.actions.run(
        serverAction.frozen,
        queue.flushPendingUpdates,
        { blockUi: false }
      );
    } else {
      void queue.flushPendingUpdates().catch(() => undefined);
    }
  }, [
    captureServerAction,
    defaults,
    queue.actions,
    queue.applyDefaultsToLocalJobs,
    queue.captureBrowserActionJobs,
    queue.flushPendingUpdates,
    queue.server.refresh,
    queue.server.status,
    queue.server.summary
  ]);

  const commitReadyJobs = useCallback(async () => {
    const capturedServerAction = captureServerAction(
      "commit_ready",
      queue.server.status !== "ready"
        || !queue.server.summary
        || queue.server.summary.ready > 0
    );
    if (capturedServerAction.required && !capturedServerAction.frozen) {
      queue.server.refresh();
      return;
    }
    const serverAction = capturedServerAction.frozen;
    const localJobs = queue.captureBrowserActionJobs((job) => (
      ingestionJobCanStartCommit(job, job.commitIntent ? "resume" : "new")
    ));
    const commitCapturedLocalJobs = () => (
      localJobs.length ? commitJobs(localJobs) : Promise.resolve(false)
    );
    if (!serverAction) {
      const committed = await commitCapturedLocalJobs();
      if (committed) onDone();
      return;
    }
    let localCommitted = false;
    const result = await queue.actions.run(serverAction, async () => {
      localCommitted = await commitCapturedLocalJobs();
    });
    if (localCommitted || (result?.changed ?? 0) > 0) onDone();
  }, [
    onDone,
    captureServerAction,
    commitJobs,
    queue.actions,
    queue.captureBrowserActionJobs,
    queue.server.refresh,
    queue.server.summary?.ready,
    queue.server.status
  ]);

  const prepareAttributeClear: PrepareImageAttributeClear = (field) => {
    const summary = queue.server.summary;
    const metadata = imageAttributeClearPatch(field);
    const frozen = queue.actions.freeze("apply_metadata", metadata);
    if (!frozen || !summary) {
      queue.server.refresh();
      return null;
    }
    const local = queue.captureLocalAttributeClear(field, queue.server.lastAcceptedOrder ?? 0);
    const pending: Array<{
      frozen: FrozenIngestionQueueAction;
      retryItems?: IngestionSessionPairDto[];
    }> = summary.unfinished - summary.committing - summary.resolving > 0
      ? [{ frozen }] : [];
    let prepared = false;
    let disposed = false;
    return {
      count: queue.uncommittedCount,
      maximumCount: true,
      dispose: () => {
        disposed = true;
        local.dispose();
      },
      apply: async () => {
        if (disposed) throw new Error("当前清空范围已失效，请重新选择");
        if (!prepared) {
          const pairs = local.apply();
          const exactBatches: typeof pending = [];
          for (let offset = 0; offset < pairs.length; offset += ingestionBatchHardLimit) {
            const exact = queue.actions.freeze("apply_metadata", metadata);
            if (!exact || exact.actionScope !== frozen.actionScope
              || exact.connectionGeneration !== frozen.connectionGeneration) {
              throw new Error("队列连接已变化，请重新选择清空范围");
            }
            exactBatches.push({
              frozen: { ...exact, items: pairs.slice(offset, offset + ingestionBatchHardLimit) }
            });
          }
          pending.push(...exactBatches);
          prepared = true;
          local.dispose();
        }
        if (!pending.length) await queue.flushPendingUpdates();
        while (pending.length) {
          const current = pending[0]!;
          if (current.retryItems) {
            const retry = queue.actions.freeze("apply_metadata", metadata);
            if (!retry || retry.actionScope !== frozen.actionScope
              || retry.connectionGeneration !== frozen.connectionGeneration) {
              throw new Error("队列连接已变化，请重新选择清空范围");
            }
            current.frozen = { ...retry, items: current.retryItems };
            current.retryItems = undefined;
          }
          const result = await queue.actions.run(current.frozen, queue.flushPendingUpdates);
          if (!result) throw new Error("队列操作结果尚未确认，请重试；已完成的修改会保留");
          const failures = result.items.filter((item) => item.status === "failed");
          if (failures.length) {
            // Retry only failed identities. Successful members and tasks added
            // after confirmation are never recaptured by a retry.
            const retryBatches = [];
            for (let offset = 0; offset < failures.length; offset += ingestionBatchHardLimit) {
              retryBatches.push({
                frozen: current.frozen,
                retryItems: failures.slice(offset, offset + ingestionBatchHardLimit).map((item) => ({
                  session_id: item.session_id, image_id: item.image_id
                }))
              });
            }
            pending.splice(0, 1, ...retryBatches);
            throw new Error(`${failures.length} 个任务清空失败：${failures[0]?.message ?? "请重试"}`);
          }
          pending.shift();
        }
      }
    };
  };

  return { applyDefaultsToQueue, prepareAttributeClear, commitReadyJobs };
}
