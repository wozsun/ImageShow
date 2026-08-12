import { checkDatabase, checkTrash } from "./database-check.ts";
import { inspectRedisState } from "./redis-inspect.ts";
import { checkStorage } from "./storage-check.ts";
import { captureAdminCheck } from "./status-errors.ts";

export async function checkSystemState(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const [database, redis, storage, trash] = await Promise.all([
    captureAdminCheck(checkDatabase, "query", "database_check_failed"),
    captureAdminCheck(
      () => inspectRedisState(signal),
      "command",
      "redis_check_failed"
    ),
    captureAdminCheck(
      () => checkStorage(signal),
      "storage",
      "storage_check_failed"
    ),
    captureAdminCheck(checkTrash, "query", "trash_check_failed")
  ]);
  // captureAdminCheck intentionally converts resource failures into DTOs, but
  // a disconnected caller is cancellation, not a storage health result.
  signal?.throwIfAborted();
  return { database, redis, storage, trash };
}
