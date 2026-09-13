import type { IngestionAttributeDefaults } from "../queue/model/ingestion-attribute-defaults.js";
import { useImport } from "../import/useImport.js";
import { useIngestionCommit } from "../queue/useIngestionCommit.js";
import { useIngestionQueue } from "../queue/useIngestionQueue.js";
import { useUpload } from "../upload/useUpload.js";
import { useIngestionRetry } from "../queue/useIngestionRetry.js";

export function useUploadQueueOwner({
  pageSize,
  displayed,
  defaults,
  storageSlug,
  maxItems,
  maxBytes,
  maxLongEdge,
  browserConcurrency,
  onDone
}: {
  pageSize: number;
  displayed: boolean;
  defaults: IngestionAttributeDefaults;
  storageSlug: string;
  maxItems: number;
  maxBytes: number;
  maxLongEdge: number;
  browserConcurrency: number;
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
    queue: queue.producerApi,
    defaults,
    storageSlug,
    maxItems,
    maxBytes,
    maxLongEdge,
    browserConcurrency
  });
  const retry = useIngestionRetry({ queue, retryBrowserJobs: uploadFlow.retryMany, commitJobs: commit.commit });
  return { queue, commit, ...uploadFlow, ...retry };
}

export function useImportQueueOwner({
  pageSize,
  displayed,
  defaults,
  keepOriginalLinkForUrlImports,
  storageSlug,
  maxItems,
  onDone
}: {
  pageSize: number;
  displayed: boolean;
  defaults: IngestionAttributeDefaults;
  keepOriginalLinkForUrlImports: boolean;
  storageSlug: string;
  maxItems: number;
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
    queue: queue.producerApi,
    defaults,
    keepOriginalLinkForUrlImports,
    storageSlug,
    maxItems
  });
  const retry = useIngestionRetry({ queue, retryBrowserJobs: importFlow.retryMany, commitJobs: commit.commit });
  return { queue, commit, ...importFlow, ...retry };
}
