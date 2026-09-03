import { getIngestionMaxFileBytes } from "../../../config/app-settings.ts";
import { ApiError } from "../../../core/api-error.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import { fetchImportImageToFile } from "./fetch.ts";
import { withIngestionExecutionHeartbeat } from "../execution/heartbeat.ts";
import {
  mutateIngestionExecution,
  updateIngestionExecutionProgress
} from "../execution/session.ts";
import {
  removeIngestionRawPart,
} from "../raw/files.ts";
import { withActiveIngestionRawPaths } from "../raw/lease-registry.ts";
import { ingestionRawPartPath, ingestionRawPath } from "../raw/paths.ts";
import type { IngestionSessionSnapshot } from "../sessions/model.ts";
import { ingestionSessionSemanticHash } from "../sessions/projection.ts";
import { IngestionSessionRepository } from "../repository.ts";

export type DownloadIngestionSessionDependencies = Readonly<{
  fetchImageToFile: typeof fetchImportImageToFile;
  maxFileBytes: () => number;
  now: () => number;
}>;

const defaultDependencies: DownloadIngestionSessionDependencies = {
  fetchImageToFile: fetchImportImageToFile,
  maxFileBytes: getIngestionMaxFileBytes,
  now: Date.now
};

export async function downloadIngestionSessionSnapshot(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  signal: AbortSignal,
  dependencies: Partial<DownloadIngestionSessionDependencies> = {}
) {
  if (
    session.status !== "downloading"
    || !session.execution_token
    || !session.import_download?.url
  ) {
    throw new ApiError(409, "invalid_ingestion_state", "导入任务不能进入下载阶段");
  }
  const rawGeneration = randomUuidV7();
  const rawPath = ingestionRawPath("import", session, rawGeneration);
  const partPath = ingestionRawPartPath(
    "import",
    session,
    rawGeneration,
    session.execution_token
  );
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  return withActiveIngestionRawPaths([rawPath, partPath], () => (
    withIngestionExecutionHeartbeat(
      repository,
      session,
      signal,
      async (executionSignal) => {
        let progressUpdateChain = Promise.resolve(session);
        let progressUpdateFailed = false;
        let progressUpdateFailure: unknown;
        const progressController = new AbortController();
        const downloadSignal = AbortSignal.any([
          executionSignal,
          progressController.signal
        ]);
        let lastProgressAt = 0;
        try {
          const rawSize = await resolvedDependencies.fetchImageToFile(
            session.import_download!.url,
            rawPath,
            partPath,
            resolvedDependencies.maxFileBytes(),
            downloadSignal,
            (value) => {
              const now = resolvedDependencies.now();
              if (
                value < 100
                && lastProgressAt
                && now - lastProgressAt < 250
              ) return;
              lastProgressAt = now;
              progressUpdateChain = progressUpdateChain.then(async (current) => (
                await updateIngestionExecutionProgress(
                  repository,
                  current,
                  {
                    phase: "downloading",
                    message: "服务器正在下载原图",
                    progress: value
                  }
                )
              ));
              // Node treats a rejection without an attached handler as fatal
              // before a slow response body reaches the final await below.
              // Observe every link immediately and stop the sibling download,
              // while retaining the original promise for ordered settlement.
              void progressUpdateChain.catch((error) => {
                if (!progressUpdateFailed) {
                  progressUpdateFailed = true;
                  progressUpdateFailure = error;
                  progressController.abort(error);
                }
              });
            }
          );
          const current = await progressUpdateChain;
          executionSignal.throwIfAborted();
          return mutateIngestionExecution(repository, current, (latest) => {
            const nextWithoutHash = {
              ...latest,
              status: "received" as const,
              phase: "prepare-waiting",
              message: "原图下载完成，等待图片处理许可",
              progress: 100,
              execution_token: "",
              raw_generation: rawGeneration,
              raw_size: rawSize,
              error: undefined,
              semantic_hash: ""
            };
            return {
              ...nextWithoutHash,
              semantic_hash: ingestionSessionSemanticHash(nextWithoutHash)
            };
          });
        } catch (error) {
          await progressUpdateChain.catch(() => undefined);
          await removeIngestionRawPart(
            "import",
            session,
            rawGeneration,
            session.execution_token
          ).catch(() => undefined);
          throw progressUpdateFailed ? progressUpdateFailure : error;
        }
      }
    )
  ));
}
