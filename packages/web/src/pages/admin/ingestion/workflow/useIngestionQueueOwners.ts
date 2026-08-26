import type { IngestionAttributeDefaults } from "../queue/model/ingestion-attribute-defaults.js";
import { useImport } from "../import/useImport.js";
import { useIngestionCommit } from "../queue/useIngestionCommit.js";
import { useIngestionQueue } from "../queue/useIngestionQueue.js";
import { useUpload } from "../upload/useUpload.js";

export function useUploadQueueOwner({
  pageSize,
  displayed,
  defaults,
  storageSlug,
  maxItems,
  maxBytes,
  maxLongEdge,
  concurrency,
  onDone
}: {
  pageSize: number;
  displayed: boolean;
  defaults: IngestionAttributeDefaults;
  storageSlug: string;
  maxItems: number;
  maxBytes: number;
  maxLongEdge: number;
  concurrency: number;
  onDone: () => void;
}) {
  const queue = useIngestionQueue(pageSize, "upload", displayed);
  const commit = useIngestionCommit({
    jobsRef: queue.jobsRef,
    updateJob: queue.updateJob,
    updateJobs: queue.updateJobs,
    updateDuplicateDecision: queue.updateDuplicateDecision,
    flushPendingUpdates: queue.flushPendingUpdates,
    observeCompletedIngestions: queue.observeCompletedIngestions,
    onDone
  });
  const uploadFlow = useUpload({
    queue: queue.workerApi,
    defaults,
    storageSlug,
    maxItems,
    maxBytes,
    maxLongEdge,
    concurrency
  });
  return { queue, commit, ...uploadFlow };
}

export function useImportQueueOwner({
  pageSize,
  displayed,
  defaults,
  fillOriginalUrl,
  storageSlug,
  onDone
}: {
  pageSize: number;
  displayed: boolean;
  defaults: IngestionAttributeDefaults;
  fillOriginalUrl: boolean;
  storageSlug: string;
  onDone: () => void;
}) {
  const queue = useIngestionQueue(pageSize, "import", displayed);
  const commit = useIngestionCommit({
    jobsRef: queue.jobsRef,
    updateJob: queue.updateJob,
    updateJobs: queue.updateJobs,
    updateDuplicateDecision: queue.updateDuplicateDecision,
    flushPendingUpdates: queue.flushPendingUpdates,
    observeCompletedIngestions: queue.observeCompletedIngestions,
    onDone
  });
  const importFlow = useImport({
    queue: queue.workerApi,
    defaults,
    fillOriginalUrl,
    storageSlug
  });
  return { queue, commit, ...importFlow };
}
