import { ApiError } from "../../../core/api-error.ts";
import { readDuplicateSnapshotByMd5 } from "../../read-models/duplicates.ts";
import type {
  IngestionSessionSnapshot,
  StoredIngestionSession
} from "../sessions/model.ts";
import type { IngestionSessionRepository } from "../repository.ts";
import { semanticIngestionSession } from "../sessions/transitions.ts";

export function ingestionSessionWithDuplicateConflict(
  current: IngestionSessionSnapshot,
  duplicateCount: number
) {
  if (!current.prepared) {
    throw new ApiError(409, "invalid_ingestion_state", "图片尚未准备完成");
  }
  return semanticIngestionSession(current, {
    status: "ready",
    phase: "ready",
    message: duplicateCount
      ? `提交前发现 ${duplicateCount} 张相同内容图片，请确认是否仍然提交`
      : "图库重复状态已变化，任务可重新提交",
    progress: null,
    execution_token: "",
    prepared: {
      ...current.prepared,
      duplicate_count: duplicateCount
    },
    duplicate_decision: undefined,
    commit: undefined,
    error: undefined
  });
}

/**
 * A duplicate can appear after a commit intent was accepted, most commonly
 * when another task with the same prepared MD5 wins the content lock first.
 * Return that task to a fresh ready decision instead of freezing a retryable
 * business conflict as a generic failed commit.
 */
export async function recoverIngestionCommitDuplicateConflict(
  repository: Pick<IngestionSessionRepository, "mutateSemantic">,
  current: StoredIngestionSession,
  error: unknown
) {
  if (
    !(error instanceof ApiError)
    || error.code !== "ingestion_duplicate_conflict"
    || current.status !== "committing"
    || !current.prepared
    || !current.commit
  ) return false;
  const duplicates = await readDuplicateSnapshotByMd5(current.prepared.md5);
  await repository.mutateSemantic(
    current,
    current.version,
    ingestionSessionWithDuplicateConflict(current, duplicates.matchCount)
  );
  return true;
}
