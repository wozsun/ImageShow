import { useCallback, useRef } from "react";
import type { ImportJob } from "../../../../lib/types.js";
import { normalizeAuthor, normalizeTheme, type CommonAttributes } from "../../../../lib/upload/upload-utils.js";
import { appendAndPrepare, linkImportJobs, retryPrepareJob } from "../import-job-utils.js";
import { applyPreparedResult, isCurrentImportAttempt, type AppendImportQueueApi } from "../prepared-result.js";
import { cancelStoredImport, createImportSession, prepareImportSession } from "../import-api.js";

export function useProxyLinkImport(options: {
  queue: AppendImportQueueApi;
  defaults: CommonAttributes;
  fillOriginalUrl: boolean;
  storageSlug: string;
  concurrency: number;
}) {
  const { queue, defaults, fillOriginalUrl, storageSlug, concurrency } = options;
  const controllers = useRef(new Map<string, AbortController>());

  const prepare = useCallback(async (job: ImportJob) => {
    if (!job.url) return;
    const attemptId = job.attemptId;
    const controller = new AbortController();
    controllers.current.set(job.id, controller);
    try {
      queue.updateJob(job.id, { status: "queued", message: "创建代理导入会话" });
      const session = await createImportSession({
        ...job.draft,
        mode: "proxy",
        source_url: job.url,
        theme: normalizeTheme(job.draft.theme),
        author: normalizeAuthor(job.draft.author),
        storage_slug: job.storageSlug,
        session_id: attemptId,
        idempotency_key: attemptId
      }, controller.signal);
      if (!isCurrentImportAttempt(queue, job.id, attemptId)) {
        await cancelStoredImport(session.id).catch(() => undefined);
        return;
      }
      queue.updateJob(job.id, { status: "processing", message: "探测外链并生成代理缩略图", sessionId: session.id });
      const result = await prepareImportSession(session, controller.signal);
      const applied = applyPreparedResult(queue, job.id, attemptId, result);
      if (applied === "duplicate") {
        await cancelStoredImport(session.id).catch(() => undefined);
        if (isCurrentImportAttempt(queue, job.id, attemptId)) {
          queue.updateJob(job.id, { status: "cancelled", message: "批次内图片重复，已取消" });
        }
      } else if (applied === "stale") {
        await cancelStoredImport(session.id).catch(() => undefined);
      }
    } catch (error) {
      const current = queue.jobsRef.current.find((item) => item.id === job.id);
      if (current?.attemptId === attemptId && current.status !== "cancelled") {
        queue.updateJob(job.id, { status: "failed", failureStage: "prepare", message: (error as Error).message });
      }
    } finally {
      if (controllers.current.get(job.id) === controller) controllers.current.delete(job.id);
    }
  }, [queue]);

  const addUrls = useCallback(async (urls: string[]) => {
    await appendAndPrepare(queue, linkImportJobs("proxy", urls, defaults, fillOriginalUrl, storageSlug), concurrency, prepare);
  }, [concurrency, defaults, fillOriginalUrl, prepare, queue, storageSlug]);

  const cancel = useCallback(async (job: ImportJob) => {
    controllers.current.get(job.id)?.abort();
    queue.updateJob(job.id, { status: "cancelled", message: "已取消" });
    await cancelStoredImport(job.sessionId ?? job.attemptId).catch(() => undefined);
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    await cancelStoredImport(job.sessionId ?? job.attemptId).catch(() => undefined);
    const stable = retryPrepareJob(job);
    queue.updateJob(job.id, stable);
    await prepare(stable);
  }, [prepare, queue]);

  return { addUrls, cancel, retry };
}
