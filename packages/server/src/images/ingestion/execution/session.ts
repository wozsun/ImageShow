import { ApiError } from "../../../core/api-error.ts";
import type { IngestionSessionSnapshot } from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";

const executionMutationAttempts = 8;

function isIngestionVersionConflict(error: unknown) {
  return error instanceof ApiError && error.code === "import_version_conflict";
}

function canAdoptIngestionExecutionVersion(
  current: IngestionSessionSnapshot,
  expected: IngestionSessionSnapshot
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

export async function refreshIngestionExecutionSession(
  repository: IngestionSessionRepository,
  expected: IngestionSessionSnapshot
) {
  const current = await repository.readSession(
    expected.owner,
    expected.session_id
  );
  if (
    !current
    || current.status === "completed"
    || current.status === "discarded"
    || !canAdoptIngestionExecutionVersion(current, expected)
  ) {
    throw new ApiError(409, "import_execution_fenced", "内容接入执行权已转移");
  }
  return current;
}

async function retryIngestionExecutionMutation(
  repository: IngestionSessionRepository,
  expected: IngestionSessionSnapshot,
  mutate: (current: IngestionSessionSnapshot) => Promise<IngestionSessionSnapshot>
) {
  let current = expected;
  for (let attempt = 0; attempt < executionMutationAttempts; attempt += 1) {
    try {
      return await mutate(current);
    } catch (error) {
      if (
        !isIngestionVersionConflict(error)
        || attempt === executionMutationAttempts - 1
      ) throw error;
    }
    current = await refreshIngestionExecutionSession(repository, current);
  }
  throw new Error("Import execution mutation exhausted its retry attempts");
}

export function updateIngestionExecutionProgress(
  repository: IngestionSessionRepository,
  expected: IngestionSessionSnapshot,
  progress: Readonly<{
    phase: string;
    message: string;
    progress: number | null;
  }>,
  now = Date.now()
) {
  return retryIngestionExecutionMutation(
    repository,
    expected,
    async (current) => (await repository.updateProgress(
      current,
      current.version,
      progress,
      now
    )).session as IngestionSessionSnapshot
  );
}

export function heartbeatIngestionExecution(
  repository: IngestionSessionRepository,
  expected: IngestionSessionSnapshot,
  now = Date.now()
) {
  return retryIngestionExecutionMutation(
    repository,
    expected,
    async (current) => (await repository.heartbeat(
      current,
      current.version,
      now
    )).session as IngestionSessionSnapshot
  );
}

export function mutateIngestionExecution(
  repository: IngestionSessionRepository,
  expected: IngestionSessionSnapshot,
  next: (current: IngestionSessionSnapshot) => IngestionSessionSnapshot,
  now = Date.now()
) {
  return retryIngestionExecutionMutation(
    repository,
    expected,
    async (current) => (await repository.mutateSemantic(
      current,
      current.version,
      next(current),
      now
    )).session as IngestionSessionSnapshot
  );
}
