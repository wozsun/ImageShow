import { useCallback } from "react";
import type { ImportJob } from "../../../../lib/types.js";
import { normalizeAuthor, normalizeTheme, type CommonAttributes } from "../../../../lib/upload/upload-utils.js";
import { appendAndPrepare, draftWithPreparedDetection, linkImportJobs, retryPrepareJob } from "../import-job-utils.js";
import { applyPreparedResult, type AppendImportQueueApi } from "../prepared-result.js";
import { cancelStoredImport, createImportSession, prepareImportSession } from "../import-api.js";

export function useProxyLinkImport(options: {
  queue: AppendImportQueueApi;
  defaults: CommonAttributes;
  fillOriginalUrl: boolean;
  storageSlug: string;
  concurrency: number;
}) {
  const { queue, defaults, fillOriginalUrl, storageSlug, concurrency } = options;

  const prepare = useCallback(async (job: ImportJob) => {
    if (!job.url) return;
    try {
      const sessionId = job.stagingId || job.id;
      queue.updateJob(job.id, { status: "queued", message: "创建代理导入会话", stagingId: sessionId });
      const session = await createImportSession({
        ...job.draft,
        mode: "proxy",
        source_url: job.url,
        theme: normalizeTheme(job.draft.theme),
        author: normalizeAuthor(job.draft.author),
        storage_slug: job.storageSlug,
        session_id: sessionId,
        idempotency_key: sessionId
      });
      queue.updateJob(job.id, { status: "processing", message: "探测外链并生成代理缩略图", stagingId: session.id });
      const result = await prepareImportSession(session);
      queue.updateJob(job.id, {
        draft: draftWithPreparedDetection(job.draft, defaults, result)
      });
      const accepted = await applyPreparedResult(queue, job.id, result);
      if (!accepted) {
        await cancelStoredImport(session.id).catch(() => undefined);
        queue.updateJob(job.id, { status: "cancelled", message: "批次内图片重复，已取消" });
      }
    } catch (error) {
      const current = queue.jobsRef.current.find((item) => item.id === job.id);
      if (current?.status !== "cancelled") queue.updateJob(job.id, { status: "failed", failureStage: "prepare", message: (error as Error).message });
    }
  }, [defaults, queue]);

  const addUrls = useCallback(async (urls: string[]) => {
    await appendAndPrepare(queue, linkImportJobs("proxy", urls, defaults, fillOriginalUrl, storageSlug), concurrency, prepare);
  }, [concurrency, defaults, fillOriginalUrl, prepare, queue, storageSlug]);

  const cancel = useCallback(async (job: ImportJob) => {
    queue.updateJob(job.id, { status: "cancelled", message: "已取消" });
    await cancelStoredImport(job.stagingId || job.id).catch(() => undefined);
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    await cancelStoredImport(job.stagingId || job.id).catch(() => undefined);
    const stable = retryPrepareJob(job);
    queue.updateJob(job.id, stable);
    await prepare(stable);
  }, [prepare, queue]);

  return { addUrls, cancel, retry };
}
