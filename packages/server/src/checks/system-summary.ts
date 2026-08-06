import { checkDatabase, checkTrash } from "./database-check.ts";
import { inspectRedisState } from "./redis-inspect.ts";
import { checkStorage } from "./storage-check.ts";
import { captureAdminCheck } from "./status-errors.ts";

export async function checkSystemState() {
  const [database, redis, storage, trash] = await Promise.all([
    captureAdminCheck(checkDatabase, "query", "database_check_failed"),
    captureAdminCheck(inspectRedisState, "command", "redis_check_failed"),
    captureAdminCheck(checkStorage, "storage", "storage_check_failed"),
    captureAdminCheck(checkTrash, "query", "trash_check_failed")
  ]);
  return { database, redis, storage, trash };
}
