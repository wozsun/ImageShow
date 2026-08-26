import { useCallback } from "react";
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

  return { applyDefaultsToQueue, commitReadyJobs };
}
