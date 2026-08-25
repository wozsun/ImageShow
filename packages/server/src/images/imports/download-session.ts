import { getInputImageMaxBytes } from "../../config/app-settings.ts";
import { ApiError } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { fetchImportImageToFile } from "./fetch.ts";
import { withImportExecutionHeartbeat } from "./execution-heartbeat.ts";
import {
  mutateImportExecution,
  updateImportExecutionProgress
} from "./execution-session.ts";
import {
  importRawPartPath,
  importRawPath,
  removeImportRawPart,
  withActiveImportRawPaths
} from "./raw-files.ts";
import type { ImportSessionSnapshot } from "./session-model.ts";
import { importSessionSemanticHash } from "./session-projection.ts";
import { ImportSessionRepository } from "./session-repository.ts";

export type DownloadImportSessionDependencies = Readonly<{
  fetchImageToFile: typeof fetchImportImageToFile;
  inputImageMaxBytes: () => number;
  now: () => number;
}>;

const defaultDependencies: DownloadImportSessionDependencies = {
  fetchImageToFile: fetchImportImageToFile,
  inputImageMaxBytes: getInputImageMaxBytes,
  now: Date.now
};

export async function downloadImportSessionSnapshot(
  repository: ImportSessionRepository,
  session: ImportSessionSnapshot,
  signal: AbortSignal,
  dependencies: Partial<DownloadImportSessionDependencies> = {}
) {
  if (
    session.status !== "downloading"
    || !session.execution_token
    || !session.remote?.url
  ) {
    throw new ApiError(409, "invalid_import_state", "远程导入任务不能进入下载阶段");
  }
  const rawGeneration = randomUuidV7();
  const rawPath = importRawPath("import", session, rawGeneration);
  const partPath = importRawPartPath(
    "import",
    session,
    rawGeneration,
    session.execution_token
  );
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  return withActiveImportRawPaths([rawPath, partPath], () => (
    withImportExecutionHeartbeat(
      repository,
      session,
      signal,
      async (executionSignal) => {
        let progress = Promise.resolve(session);
        let progressFailed = false;
        let progressFailure: unknown;
        const progressController = new AbortController();
        const downloadSignal = AbortSignal.any([
          executionSignal,
          progressController.signal
        ]);
        let lastProgressAt = 0;
        try {
          const rawSize = await resolvedDependencies.fetchImageToFile(
            session.remote!.url,
            rawPath,
            partPath,
            resolvedDependencies.inputImageMaxBytes(),
            downloadSignal,
            (value) => {
              const now = resolvedDependencies.now();
              if (
                value < 100
                && lastProgressAt
                && now - lastProgressAt < 250
              ) return;
              lastProgressAt = now;
              progress = progress.then(async (current) => (
                await updateImportExecutionProgress(
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
              void progress.catch((error) => {
                if (!progressFailed) {
                  progressFailed = true;
                  progressFailure = error;
                  progressController.abort(error);
                }
              });
            }
          );
          const current = await progress;
          executionSignal.throwIfAborted();
          return mutateImportExecution(repository, current, (latest) => {
            const nextWithoutHash = {
              ...latest,
              status: "received" as const,
              phase: "received",
              message: "原图下载完成，等待服务器处理",
              progress: 100,
              execution_token: "",
              raw_generation: rawGeneration,
              raw_size: rawSize,
              error: undefined,
              semantic_hash: ""
            };
            return {
              ...nextWithoutHash,
              semantic_hash: importSessionSemanticHash(nextWithoutHash)
            };
          });
        } catch (error) {
          await progress.catch(() => undefined);
          await removeImportRawPart(
            "import",
            session,
            rawGeneration,
            session.execution_token
          ).catch(() => undefined);
          throw progressFailed ? progressFailure : error;
        }
      }
    )
  ));
}
