import type { AdminImageListItem, ImportJob } from "../../../lib/types.js";
import {
  importBatchHardLimit,
  importStatusBatchMaxItems
} from "@imageshow/shared/browser";
import { runWithConcurrency } from "../../../lib/upload/upload-utils.js";
import {
  commitStoredImports,
  getStoredImportStatuses,
  type StoredImportCommitResult,
  type StoredImportStatus
} from "./import-api.js";
import {
  commitResultFailurePatch,
  importStatusEventPatch
} from "./import-status-state.js";

type CommitSelectedImportsOptions = {
  selected: ImportJob[];
  concurrency: number;
  getJob: (id: string) => ImportJob | undefined;
  updateJob: (id: string, patch: Partial<ImportJob>) => void;
  completeJob: (
    id: string,
    commitAttemptId: string,
    patch: Partial<ImportJob>,
    item: AdminImageListItem
  ) => boolean;
};

type PendingImport = {
  job: ImportJob;
  error: unknown;
  status?: StoredImportStatus;
};

function commitInput(job: ImportJob) {
  if (!job.sessionId || !job.commitIntent) {
    throw new Error("提交会话或提交意图不存在");
  }
  return {
    id: job.sessionId.toLowerCase(),
    metadata: job.commitIntent.metadata
  };
}

function currentCommitJob(
  options: CommitSelectedImportsOptions,
  selected: ImportJob
) {
  const current = options.getJob(selected.id);
  return current?.commitIntent?.attemptId === selected.commitIntent?.attemptId
    ? current
    : undefined;
}

function completedImport(
  result: StoredImportCommitResult,
  importedMessage: string
) {
  return {
    patch: {
      status: "done" as const,
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
      resultState: "hydrated" as const,
      resultError: undefined,
      message: importedMessage,
      preview: result.item.thumb_url,
      previewFull: result.item.object_url
    },
    item: result.item
  };
}

function acceptImportedResult(
  options: CommitSelectedImportsOptions,
  job: ImportJob,
  result: StoredImportCommitResult,
  message: string
) {
  const attemptId = job.commitIntent?.attemptId;
  if (!attemptId) return undefined;
  const completed = completedImport(result, message);
  return options.completeJob(
    job.id,
    attemptId,
    completed.patch,
    completed.item
  ) ? completed.item : undefined;
}

function applyCommitFailure(
  options: CommitSelectedImportsOptions,
  entry: PendingImport,
  error = entry.error
) {
  const current = currentCommitJob(options, entry.job);
  if (!current) return;
  options.updateJob(
    current.id,
    commitResultFailurePatch(current, entry.status, error)
  );
}

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
        // A failed status chunk remains unknown while other chunks can still
        // recover their authoritative session state.
      }
    }
  );
  return statuses;
}

async function recoverFinalizedImports(
  pending: PendingImport[],
  options: CommitSelectedImportsOptions
) {
  for (const { job } of pending) {
    const current = currentCommitJob(options, job);
    if (!current) continue;
    options.updateJob(job.id, {
      status: "finalized",
      resultState: "recovering",
      resultError: undefined,
      message: "正在确认提交结果"
    });
  }

  let recoveryError: unknown;
  let recoveryResults: Awaited<
    ReturnType<typeof commitStoredImports>
  >["items"] = [];
  try {
    recoveryResults = (await commitStoredImports(
      pending.map(({ job }) => commitInput(job))
    )).items;
  } catch (error) {
    recoveryError = error;
  }
  const resultsById = new Map(
    recoveryResults.map((result) => [result.id.toLowerCase(), result])
  );
  const acceptedItems: AdminImageListItem[] = [];
  for (const entry of pending) {
    const result = resultsById.get(entry.job.sessionId!.toLowerCase());
    if (result?.status === "imported") {
      const accepted = acceptImportedResult(
        options,
        entry.job,
        result,
        "服务端已完成提交"
      );
      if (accepted) acceptedItems.push(accepted);
      continue;
    }
    applyCommitFailure(
      options,
      entry,
      recoveryError ?? new Error(
        result?.message ?? "服务端已完成提交，但批量结果恢复未返回该会话"
      )
    );
  }
  return acceptedItems;
}

async function commitSelectedImportBatch(
  options: CommitSelectedImportsOptions
) {
  const { selected, concurrency } = options;
  let batchError: unknown;
  let batchResults: Awaited<ReturnType<typeof commitStoredImports>>["items"] = [];
  try {
    batchResults = (await commitStoredImports(selected.map(commitInput))).items;
  } catch (error) {
    batchError = error;
  }
  const resultsById = new Map(
    batchResults.map((result) => [result.id.toLowerCase(), result])
  );
  const acceptedItems: AdminImageListItem[] = [];
  const pending: PendingImport[] = [];
  for (const job of selected) {
    const result = resultsById.get(job.sessionId!.toLowerCase());
    if (result?.status === "imported") {
      const accepted = acceptImportedResult(options, job, result, "已完成");
      if (accepted) acceptedItems.push(accepted);
      continue;
    }
    pending.push({
      job,
      error: batchError ?? new Error(
        result?.message ?? "批量提交未返回该导入会话的结果"
      )
    });
  }
  if (!pending.length) return acceptedItems;

  const statuses = await readPendingImportStatuses(pending, concurrency);
  for (const entry of pending) {
    entry.status = statuses.get(entry.job.sessionId!.toLowerCase());
    const current = currentCommitJob(options, entry.job);
    if (!current || !entry.status) continue;
    const authorityPatch = importStatusEventPatch(current, entry.status);
    if (authorityPatch) options.updateJob(current.id, authorityPatch);
  }

  const finalized = pending.filter((entry) => {
    const current = currentCommitJob(options, entry.job);
    return entry.status?.status === "finalized"
      || current?.status === "finalized"
      || current?.serverStatus === "finalized";
  });
  const finalizedIds = new Set(finalized.map(({ job }) => job.id));
  for (const entry of pending) {
    if (!finalizedIds.has(entry.job.id)) applyCommitFailure(options, entry);
  }
  if (finalized.length) {
    acceptedItems.push(...await recoverFinalizedImports(finalized, options));
  }
  return acceptedItems;
}

export async function commitSelectedImports(
  options: CommitSelectedImportsOptions
) {
  const acceptedItems: AdminImageListItem[] = [];
  for (
    let offset = 0;
    offset < options.selected.length;
    offset += importBatchHardLimit
  ) {
    acceptedItems.push(...await commitSelectedImportBatch({
      ...options,
      selected: options.selected.slice(offset, offset + importBatchHardLimit)
    }));
  }
  return acceptedItems;
}
