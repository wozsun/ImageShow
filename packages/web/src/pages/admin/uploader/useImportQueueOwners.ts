import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import { useLinkImport } from "./link-import/useLinkImport.js";
import { useImportCommit } from "./useImportCommit.js";
import { useImportQueue } from "./useImportQueue.js";
import { useLocalUploadImport } from "./useLocalUploadImport.js";

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
  defaults: ImportAttributeDefaults;
  storageSlug: string;
  maxItems: number;
  maxBytes: number;
  maxLongEdge: number;
  concurrency: number;
  onDone: () => void;
}) {
  const queue = useImportQueue(pageSize, "upload", displayed);
  const commit = useImportCommit({
    jobsRef: queue.jobsRef,
    updateJob: queue.updateJob,
    updateJobs: queue.updateJobs,
    updateDuplicateDecision: queue.updateDuplicateDecision,
    flushPendingUpdates: queue.flushPendingUpdates,
    observeCompletedImports: queue.observeCompletedImports,
    onDone
  });
  const local = useLocalUploadImport({
    queue: queue.workerApi,
    defaults,
    storageSlug,
    maxItems,
    maxBytes,
    maxLongEdge,
    concurrency
  });
  return { queue, commit, ...local };
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
  defaults: ImportAttributeDefaults;
  fillOriginalUrl: boolean;
  storageSlug: string;
  onDone: () => void;
}) {
  const queue = useImportQueue(pageSize, "import", displayed);
  const commit = useImportCommit({
    jobsRef: queue.jobsRef,
    updateJob: queue.updateJob,
    updateJobs: queue.updateJobs,
    updateDuplicateDecision: queue.updateDuplicateDecision,
    flushPendingUpdates: queue.flushPendingUpdates,
    observeCompletedImports: queue.observeCompletedImports,
    onDone
  });
  const remote = useLinkImport({
    queue: queue.workerApi,
    defaults,
    fillOriginalUrl,
    storageSlug
  });
  return { queue, commit, ...remote };
}
