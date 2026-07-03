import { useCallback } from "react";
import type { ImportJob } from "../../../lib/types.js";
import { normalizeAuthor, normalizeTheme, runWithConcurrency } from "../../../lib/upload/upload-utils.js";
import { commitStoredImport } from "./import-api.js";

export function useImportCommit(options: {
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  concurrency: number;
  onDone: () => void;
}) {
  const { updateJob, concurrency, onDone } = options;
  return useCallback(async (jobs: ImportJob[]) => {
    await runWithConcurrency(jobs, concurrency, async (job) => {
      try {
        updateJob(job.id, { status: "committing", message: "写入图库" });
        const draft = { ...job.draft, theme: normalizeTheme(job.draft.theme), author: normalizeAuthor(job.draft.author) };
        if (!job.stagingId) throw new Error("导入会话不存在");
        const result = await commitStoredImport(job.stagingId, draft);
        updateJob(job.id, {
          status: "done",
          message: result.status === "duplicate" ? "图片已存在（跳过）" : "已完成",
          preview: result.item?.thumb_url ?? job.preview,
          previewFull: result.item?.object_url ?? job.previewFull ?? job.preview
        });
      } catch (error) {
        updateJob(job.id, { status: "failed", failureStage: "commit", message: (error as Error).message });
      }
    });
    onDone();
  }, [concurrency, onDone, updateJob]);
}
