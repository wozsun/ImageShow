import type {
  StoredImportBatchCommitItemInputDto,
  StoredImportBatchCommitItemResultDto,
  StoredImportBatchCommitResultDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { ApiError } from "../../core/api-error.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { withPlannedImageMutation } from "../mutation-sync.ts";
import { commitImportSession } from "./commit.ts";

function failedImportResult(
  id: string,
  error: unknown
): StoredImportBatchCommitItemResultDto {
  if (error instanceof ApiError) {
    return {
      id,
      status: "failed",
      code: error.code,
      message: error.message
    };
  }
  return {
    id,
    status: "failed",
    code: "import_commit_failed",
    message: "Image import failed"
  };
}

export async function commitImportSessions(
  items: StoredImportBatchCommitItemInputDto[],
  signal?: AbortSignal
): Promise<StoredImportBatchCommitResultDto> {
  const commitSignal = signal ?? new AbortController().signal;
  const normalizedItems = items.map((item) => ({
    ...item,
    id: item.id.toLowerCase()
  }));
  const execute = async () => {
    const concurrency = getRuntimeConfig().import.commit_concurrency;
    const results = await mapWithWorkerPool(
      normalizedItems,
      concurrency,
      async (item): Promise<StoredImportBatchCommitItemResultDto> => {
        try {
          const result = await commitImportSession(
            item.id,
            item.metadata,
            commitSignal
          );
          return { id: item.id, ...result };
        } catch (error) {
          commitSignal.throwIfAborted();
          return failedImportResult(item.id, error);
        }
      },
      { signal: commitSignal }
    );
    const imported = results.filter((result) => result.status === "imported").length;
    return {
      imported,
      failed: results.length - imported,
      items: results
    };
  };

  const affectedCount = new Set(
    normalizedItems.map((item) => item.id)
  ).size;
  return withPlannedImageMutation(affectedCount, execute);
}
