import { ApiError } from "../../../core/api-error.ts";
import { assertStorageTargetAvailable } from "../../../storage/objects/transfer.ts";
import { readDuplicateSnapshotByMd5 } from "../../read-models/duplicates.ts";
import type {
  IngestionPreparedManifest,
  IngestionSessionSnapshot
} from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";

type CommitTargetAvailability = Omit<
  Parameters<typeof assertStorageTargetAvailable>[0],
  "signal"
>;

/** Cancel and drain sibling digests before releasing the storage lock. */
export async function assertCommitTargetsAvailable(
  targets: readonly CommitTargetAvailability[],
  signal: AbortSignal
) {
  const siblingAbort = new AbortController();
  const checkSignal = AbortSignal.any([signal, siblingAbort.signal]);
  let failed = false;
  let firstFailure: unknown;
  const checks = targets.map(async (target) => {
    try {
      await assertStorageTargetAvailable({
        ...target,
        signal: checkSignal
      });
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
        siblingAbort.abort(error);
      }
      throw error;
    }
  });
  await Promise.allSettled(checks);
  signal.throwIfAborted();
  if (failed) throw firstFailure;
}

export async function assertCurrentCommitExecution(
  repository: IngestionSessionRepository,
  expected: IngestionSessionSnapshot
) {
  const current = await repository.readSession(
    expected.owner,
    expected.session_id
  );
  if (
    !current
    || !("execution_token" in current)
    || current.image_id !== expected.image_id
    || current.status !== "committing"
    || current.version !== expected.version
    || current.execution_token !== expected.execution_token
  ) {
    throw new ApiError(409, "ingestion_execution_fenced", "内容接入提交执行权已转移");
  }
}

export async function assertCurrentDuplicateDecision(
  imageId: string,
  prepared: IngestionPreparedManifest,
  decision: "upload" | "confirmed"
) {
  const duplicates = (await readDuplicateSnapshotByMd5(prepared.md5)).items
    .filter((item) => item.id.toLowerCase() !== imageId.toLowerCase());
  if (duplicates.length && decision !== "confirmed") {
    throw new ApiError(
      409,
      "ingestion_duplicate_conflict",
      "提交前发现相同内容图片，请确认是否仍然提交",
      { duplicates }
    );
  }
}
