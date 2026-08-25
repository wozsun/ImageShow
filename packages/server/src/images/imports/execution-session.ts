import { ApiError } from "../../core/api-error.ts";
import type { ImportSessionSnapshot } from "./session-model.ts";
import { ImportSessionRepository } from "./session-repository.ts";

const executionMutationAttempts = 8;

function isImportVersionConflict(error: unknown) {
  return error instanceof ApiError && error.code === "import_version_conflict";
}

function canAdoptImportExecutionVersion(
  current: ImportSessionSnapshot,
  expected: ImportSessionSnapshot
) {
  if (
    current.owner !== expected.owner
    || current.queue !== expected.queue
    || current.session_id !== expected.session_id
    || current.image_id !== expected.image_id
    || current.status !== expected.status
    || !current.execution_token
    || current.execution_token !== expected.execution_token
    || current.version < expected.version
  ) return false;
  return current.version === expected.version
    || current.status === "downloading"
    || current.status === "preparing";
}

export async function refreshImportExecutionSession(
  repository: ImportSessionRepository,
  expected: ImportSessionSnapshot
) {
  const current = await repository.readSession(
    expected.owner,
    expected.session_id
  );
  if (
    !current
    || current.status === "completed"
    || current.status === "discarded"
    || !canAdoptImportExecutionVersion(current, expected)
  ) {
    throw new ApiError(409, "import_execution_fenced", "导入执行权已转移");
  }
  return current;
}

async function retryImportExecutionMutation(
  repository: ImportSessionRepository,
  expected: ImportSessionSnapshot,
  mutate: (current: ImportSessionSnapshot) => Promise<ImportSessionSnapshot>
) {
  let current = expected;
  for (let attempt = 0; attempt < executionMutationAttempts; attempt += 1) {
    try {
      return await mutate(current);
    } catch (error) {
      if (
        !isImportVersionConflict(error)
        || attempt === executionMutationAttempts - 1
      ) throw error;
    }
    current = await refreshImportExecutionSession(repository, current);
  }
  throw new Error("Import execution mutation exhausted its retry attempts");
}

export function updateImportExecutionProgress(
  repository: ImportSessionRepository,
  expected: ImportSessionSnapshot,
  progress: Readonly<{
    phase: string;
    message: string;
    progress: number | null;
  }>,
  now = Date.now()
) {
  return retryImportExecutionMutation(
    repository,
    expected,
    async (current) => (await repository.updateProgress(
      current,
      current.version,
      progress,
      now
    )).session as ImportSessionSnapshot
  );
}

export function heartbeatImportExecution(
  repository: ImportSessionRepository,
  expected: ImportSessionSnapshot,
  now = Date.now()
) {
  return retryImportExecutionMutation(
    repository,
    expected,
    async (current) => (await repository.heartbeat(
      current,
      current.version,
      now
    )).session as ImportSessionSnapshot
  );
}

export function mutateImportExecution(
  repository: ImportSessionRepository,
  expected: ImportSessionSnapshot,
  next: (current: ImportSessionSnapshot) => ImportSessionSnapshot,
  now = Date.now()
) {
  return retryImportExecutionMutation(
    repository,
    expected,
    async (current) => (await repository.mutateSemantic(
      current,
      current.version,
      next(current),
      now
    )).session as ImportSessionSnapshot
  );
}
