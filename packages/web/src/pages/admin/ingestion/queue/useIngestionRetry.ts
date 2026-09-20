import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeAuthor, normalizeTheme } from "../../../../lib/image-draft.js";
import type { IngestionJob } from "./model/ingestion-job.js";
import { updateStoredIngestions } from "./ingestion-http-client.js";
import { ingestionJobIsRetryableFailure, ingestionJobRetryKind } from "./model/ingestion-job-retry.js";
import type { IngestionQueueController } from "./useIngestionQueue.js";

export function useIngestionRetry({ queue, retryBrowserJobs, commitJobs }: {
  queue: IngestionQueueController;
  retryBrowserJobs: (jobs: readonly IngestionJob[]) => Promise<void>;
  commitJobs: (jobs: IngestionJob[]) => Promise<boolean>;
}) {
  const active = useRef(new Set<string>());
  const bulkActive = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [retryingAll, setRetryingAll] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const currentControllers = controllers.current;
    return () => {
      mounted.current = false;
      for (const controller of currentControllers) controller.abort();
      currentControllers.clear();
    };
  }, []);

  const retry = useCallback(async (target: IngestionJob) => {
    if (bulkActive.current) return;
    const current = queue.jobsRef.current.find((job) => job.id === target.id && job.attemptKey === target.attemptKey);
    if (!current || current.status !== target.status) return;
    const kind = ingestionJobRetryKind(current);
    const key = `${current.id}\0${current.attemptKey}`;
    if (!kind || active.current.has(key)) return;
    active.current.add(key);
    setPending(new Set(active.current));
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      if (kind === "commit") {
        await commitJobs([current]);
      } else if (kind === "browser-prepare") {
        await retryBrowserJobs([current]);
      } else {
        const { items } = await updateStoredIngestions([{
          session_id: current.sessionId!, image_id: current.imageId!,
          expected_version: current.serverVersion!,
          metadata: { ...current.draft, theme: normalizeTheme(current.draft.theme), author: normalizeAuthor(current.draft.author) },
          retry_prepare: true
        }], controller.signal);
        const result = items[0];
        if (!result || result.status === "failed") throw new Error(result?.message ?? "重试响应缺少当前任务");
      }
    } catch (error) {
      const latest = queue.jobsRef.current.find((job) => job.id === current.id && job.attemptKey === current.attemptKey);
      if (mounted.current && !controller.signal.aborted && latest?.serverVersion === current.serverVersion) {
        queue.updateJob(current.id, { message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      controllers.current.delete(controller);
      if (kind === "server-prepare" && mounted.current && !controller.signal.aborted) {
        await queue.server.recoverAfterSuccessfulAction().catch(() => undefined);
      }
      active.current.delete(key);
      if (mounted.current) setPending(new Set(active.current));
    }
  }, [commitJobs, queue, retryBrowserJobs]);

  // Accepted failures retain a recoverable server source or a frozen commit.
  // Browser-only failures also need their file/URL. A bounded page by itself
  // cannot prove that the rest of the queue has failed.
  const summary = queue.server.summary;
  const canRetryAll = queue.server.status === "ready" && summary !== null
    && queue.totalItems > 0 && !queue.pendingAuthorityHandoff
    && !queue.hasPendingDraftUpdates()
    && queue.totalItems === summary.total + queue.localJobs.length
    && summary.total === summary.failed
    && queue.localJobs.every(ingestionJobIsRetryableFailure)
    && queue.jobs.every(ingestionJobIsRetryableFailure);

  const retryAll = useCallback(async () => {
    if (!canRetryAll || active.current.size || bulkActive.current || queue.actions.busy) return;
    const frozen = summary!.total ? queue.actions.freeze("retry_failed") : null;
    if (summary!.total && !frozen) return;
    const local = queue.captureBrowserActionJobs(ingestionJobIsRetryableFailure);
    bulkActive.current = true;
    setRetryingAll(true);
    try {
      const retryLocal = async () => {
        await queue.flushPendingUpdates();
        await retryBrowserJobs(local);
      };
      if (frozen) {
        await queue.actions.run(frozen, retryLocal, {
          onSettled: async () => {
            await queue.server.recoverAfterSuccessfulAction().catch(() => undefined);
            return true;
          }
        });
      } else {
        await retryLocal();
      }
    } finally {
      bulkActive.current = false;
      if (mounted.current) {
        setRetryingAll(false);
      }
    }
  }, [canRetryAll, queue, retryBrowserJobs, summary]);

  const isRetryPending = useCallback((job: IngestionJob) => (
    pending.has(`${job.id}\0${job.attemptKey}`)
  ), [pending]);
  return { retry, retryAll, canRetryAll, retryBusy: pending.size > 0 || retryingAll, retryingAll, isRetryPending };
}
