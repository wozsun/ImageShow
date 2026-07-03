import { useCallback } from "react";
import { api } from "../../../../lib/api/client.js";
import { adminApiBasePath } from "../../../../lib/constants.js";
import type { ImportJob } from "../../../../lib/types.js";
import { type CommonAttributes } from "../../../../lib/upload/upload-utils.js";
import { appendAndPrepare, draftWithPreparedDetection, linkImportJobs, retryPrepareJob } from "../import-job-utils.js";
import { applyPreparedResult, type AppendImportQueueApi } from "../prepared-result.js";
import type { PreparedImport } from "../import-api.js";

type ProxyPrepared = Omit<PreparedImport, "id" | "preview_url"> & {
  staging_id: string;
  thumb_data_url: string;
  url: string;
};

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
      const stagingId = job.stagingId || job.id;
      queue.updateJob(job.id, { status: "downloading", message: "下载原图并生成代理缩略图", stagingId });
      const result = await api<ProxyPrepared>(`${adminApiBasePath}/import-links/prepare`, {
        method: "POST",
        body: JSON.stringify({ url: job.url, staging_id: stagingId, storage_slug: job.storageSlug })
      });
      queue.updateJob(job.id, {
        draft: draftWithPreparedDetection(job.draft, defaults, result)
      });
      const accepted = await applyPreparedResult(queue, job.id, {
        ...result,
        id: result.staging_id,
        preview_url: result.thumb_data_url
      });
      if (accepted) queue.updateJob(job.id, { previewFull: `${adminApiBasePath}/import-links/${encodeURIComponent(stagingId)}/preview` });
      if (!accepted) {
        await api(`${adminApiBasePath}/import-links/${stagingId}/cancel`, { method: "POST" }).catch(() => undefined);
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
    await api(`${adminApiBasePath}/import-links/${job.stagingId || job.id}/cancel`, { method: "POST" }).catch(() => undefined);
  }, [queue]);

  const retry = useCallback(async (job: ImportJob) => {
    await api(`${adminApiBasePath}/import-links/${job.stagingId || job.id}/cancel`, { method: "POST" }).catch(() => undefined);
    const stable = retryPrepareJob(job);
    queue.updateJob(job.id, stable);
    await prepare(stable);
  }, [prepare, queue]);

  return { addUrls, cancel, retry };
}
