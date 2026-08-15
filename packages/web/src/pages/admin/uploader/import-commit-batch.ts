import type { AdminImageListItem, ImportJob } from "../../../lib/types.js";
import {
  importBatchHardLimit,
  importStatusBatchMaxItems
} from "@imageshow/shared/browser";
import {
  normalizeAuthor,
  normalizeTheme,
  runWithConcurrency
} from "../../../lib/upload/upload-utils.js";
import {
  commitStoredImports,
  getStoredImportStatuses,
  type StoredImportCommitResult,
  type StoredImportStatus
} from "./import-api.js";
import { commitFailurePatchForStatus } from "./import-status-state.js";

function normalizedCommitDraft(job: ImportJob) {
  return {
    ...job.draft,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author)
  };
}

type CompletedImport = {
  patch: Partial<ImportJob>;
  item: AdminImageListItem;
};

function completedImport(
  result: StoredImportCommitResult,
  importedMessage: string
): CompletedImport {
  return {
    patch: {
      status: "done",
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
      recoveringCommitResult: false,
      message: importedMessage,
      preview: result.item.thumb_url,
      previewFull: result.item.object_url
    },
    item: result.item
  };
}

type CommitSelectedImportsOptions = {
  selected: ImportJob[];
  concurrency: number;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  completeJob: (id: string, patch: Partial<ImportJob>, item: AdminImageListItem) => void;
};

type PendingImport = {
  job: ImportJob;
  error: unknown;
  status?: StoredImportStatus;
};

async function readPendingImportStatuses(
  pending: PendingImport[],
  concurrency: number
) {
  const ids = [...new Set(
    pending.map(({ job }) => job.sessionId!.toLowerCase())
  )];
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += importStatusBatchMaxItems) {
    chunks.push(ids.slice(offset, offset + importStatusBatchMaxItems));
  }
  const statuses = new Map<string, StoredImportStatus>();
  await runWithConcurrency(
    chunks,
    Math.max(1, Math.min(concurrency, 4)),
    async (chunk) => {
      try {
        const states = await getStoredImportStatuses(chunk);
        for (const state of states) {
          statuses.set(state.id.toLowerCase(), state);
        }
      } catch {
        // A failed status chunk remains unknown. Other chunks can still
        // recover their authoritative session states.
      }
    }
  );
  return statuses;
}

async function recoverFinalizedImports(
  pending: PendingImport[],
  completeJob: CommitSelectedImportsOptions["completeJob"],
  updateJob: CommitSelectedImportsOptions["updateJob"]
) {
  for (const { job } of pending) {
    updateJob(job.id, {
      status: "committing",
      recoveringCommitResult: true
    });
  }
  let recoveryError: unknown;
  let recoveryResults: Awaited<
    ReturnType<typeof commitStoredImports>
  >["items"] = [];
  try {
    recoveryResults = (await commitStoredImports(pending.map(({ job }) => ({
      id: job.sessionId!.toLowerCase(),
      metadata: normalizedCommitDraft(job)
    })))).items;
  } catch (error) {
    recoveryError = error;
  }
  const resultsById = new Map(
    recoveryResults.map((result) => [result.id.toLowerCase(), result])
  );
  let imported = false;
  for (const entry of pending) {
    const result = resultsById.get(entry.job.sessionId!.toLowerCase());
    if (result?.status === "imported") {
      imported = true;
      const completed = completedImport(result, "服务端已完成提交");
      completeJob(entry.job.id, completed.patch, completed.item);
      continue;
    }
    const error = recoveryError ?? new Error(
      result?.message ?? "服务端已完成提交，但批量结果恢复未返回该会话"
    );
    updateJob(
      entry.job.id,
      commitFailurePatchForStatus(entry.status, error)
    );
  }
  return imported;
}

async function commitSelectedImportBatch(
  options: CommitSelectedImportsOptions
) {
  const {
    selected,
    concurrency,
    updateJob,
    completeJob
  } = options;
  let imported = false;
  let batchError: unknown;
  let batchResults: Awaited<ReturnType<typeof commitStoredImports>>["items"] = [];
  try {
    batchResults = (await commitStoredImports(selected.map((job) => ({
      id: job.sessionId!.toLowerCase(),
      metadata: normalizedCommitDraft(job)
    })))).items;
  } catch (error) {
    batchError = error;
  }
  const resultsById = new Map(
    batchResults.map((result) => [result.id.toLowerCase(), result])
  );
  const pending: PendingImport[] = [];
  for (const job of selected) {
    const result = resultsById.get(job.sessionId!.toLowerCase());
    if (result?.status === "imported") {
      imported = true;
      const completed = completedImport(result, "已完成");
      completeJob(job.id, completed.patch, completed.item);
      continue;
    }
    pending.push({
      job,
      error: batchError ?? new Error(
        result?.message ?? "批量提交未返回该导入会话的结果"
      )
    });
  }
  if (!pending.length) return imported;

  const statuses = await readPendingImportStatuses(pending, concurrency);
  for (const entry of pending) {
    entry.status = statuses.get(entry.job.sessionId!.toLowerCase());
  }
  const finalized = pending.filter(({ status }) => status?.status === "finalized");
  for (const entry of pending) {
    if (entry.status?.status === "finalized") continue;
    updateJob(
      entry.job.id,
      commitFailurePatchForStatus(entry.status, entry.error)
    );
  }
  if (finalized.length) {
    imported ||= await recoverFinalizedImports(
      finalized,
      completeJob,
      updateJob
    );
  }
  return imported;
}

export async function commitSelectedImports(
  options: CommitSelectedImportsOptions
) {
  let imported = false;
  for (
    let offset = 0;
    offset < options.selected.length;
    offset += importBatchHardLimit
  ) {
    const batchImported = await commitSelectedImportBatch({
      ...options,
      selected: options.selected.slice(offset, offset + importBatchHardLimit)
    });
    imported ||= batchImported;
  }
  return imported;
}
