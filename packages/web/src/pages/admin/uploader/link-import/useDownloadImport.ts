import { useCallback, useRef } from "react";
import type { ImportJob } from "../../../../lib/types.js";
import { normalizeAuthor, normalizeTheme, type CommonAttributes } from "../../../../lib/upload/upload-utils.js";
import { appendAndPrepare, linkImportJobs, retryPrepareJob } from "../import-job-utils.js";
import { applyPreparedResult, type AppendImportQueueApi } from "../prepared-result.js";
import { cancelStoredImport, createImportSession, prepareImportSession } from "../import-api.js";

export function useDownloadImport(options: {
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
    const controller = new AbortController();
    controllers.current.set(job.id, controller);
    try {
      const sessionId = job.stagingId || job.id;
      queue.updateJob(job.id, { status: "queued", message: "创建下载会话", stagingId: sessionId });
      const session = await createImportSession({
        ...job.draft,
        mode: "download",
        source_url: job.url,
        theme: normalizeTheme(job.draft.theme),
        author: normalizeAuthor(job.draft.author),
        storage_slug: job.storageSlug,
        session_id: sessionId,
        idempotency_key: sessionId
      });
      queue.updateJob(job.id, { status: "downloading", message: "服务端下载原图", stagingId: session.id });
      const prepared = await prepareImportSession(session, controller.signal);
      const accepted = await applyPreparedResult(queue, job.id, prepared);
      if (!accepted) {
        // 批次内重复会释放服务端暂存文件，避免用户看不到的重复任务占用 _uploads。
        await cancelStoredImport(session.id).catch(() => undefined);
        queue.updateJob(job.id, { status: "cancelled", message: "批次内最终文件重复，已取消" });
      }
    } catch (error) {
      const current = queue.jobsRef.current.find((item) => item.id === job.id);
      if (current?.status !== "cancelled") queue.updateJob(job.id, { status: "failed", failureStage: "prepare", message: (error as Error).message });
    } finally {
      controllers.current.delete(job.id);
    }
  }, [queue]);

  const addUrls = useCallback(async (urls: string[]) => {
    await appendAndPrepare(queue, linkImportJobs("download", urls, defaults, fillOriginalUrl, storageSlug), concurrency, prepare);
  }, [concurrency, defaults, fillOriginalUrl, prepare, queue, storageSlug]);

  const cancel = useCallback(async (job: ImportJob) => {
    controllers.current.get(job.id)?.abort();
    queue.updateJob(job.id, { status: "cancelled", message: "已取消" });
    await cancelStoredImport(job.stagingId || job.id).catch(() => undefined);
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    if (job.stagingId) await cancelStoredImport(job.stagingId).catch(() => undefined);
    const next = retryPrepareJob(job);
    queue.updateJob(job.id, next);
    await prepare(next);
  }, [prepare, queue]);

  return { addUrls, cancel, retry };
}
