import { appConfig } from "@imageshow/shared";
import { pool } from "../../core/db.ts";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { redis } from "../../core/redis-client.ts";
import type { ImportStatus } from "./types.ts";
import {
  clearImportPhase,
  notifyImportStatus
} from "./status.ts";

const cancelledImports = new Map<string, number>();
const importLeaseHeartbeatMs = Math.max(
  1_000,
  Math.min(30_000, Math.floor(appConfig.uploadTtlSeconds * 1_000 / 3))
);

function cancelledImportKey(id: string) {
  return `imageshow:import-cancelled:${id}`;
}

async function renewImportLease(id: string, required = false) {
  const renewed = await pool.query(
    `UPDATE import_session
        SET expires_at=now() + ($2 * interval '1 second')
      WHERE id=$1 AND status IN (
        'created','materializing','received','preparing','ready','committing'
      )`,
    [id, appConfig.uploadTtlSeconds]
  );
  if (required && !renewed.rowCount) {
    throw new ApiError(409, "invalid_import_state", "导入任务已结束或不存在");
  }
}

export async function withImportLease<T>(
  id: string,
  work: () => Promise<T>
) {
  await renewImportLease(id, true);
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => renewImportLease(id))
      .catch(() => undefined);
  }, importLeaseHeartbeatMs);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

export async function importWasCancelled(id: string) {
  const expires = cancelledImports.get(id) ?? 0;
  if (expires > Date.now()) return true;
  if (expires) cancelledImports.delete(id);
  return Boolean(
    await redis.get(cancelledImportKey(id)).catch(() => null)
  );
}

export async function markImportCancelled(id: string) {
  clearImportPhase(id);
  cancelledImports.set(
    id,
    Date.now() + appConfig.uploadTtlSeconds * 1_000
  );
  await redis
    .set(cancelledImportKey(id), "1", "EX", appConfig.uploadTtlSeconds)
    .catch(() => undefined);
}

export async function clearImportCancelled(id: string) {
  cancelledImports.delete(id);
  await redis.del(cancelledImportKey(id)).catch(() => undefined);
}

export async function assertImportStillPreparing(
  id: string,
  executionToken: string
) {
  const row = (await pool.query(
    "SELECT status, execution_token FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as {
    status?: ImportStatus;
    execution_token?: string | null;
  } | undefined;
  if (!row || row.status === "cancelled") {
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }
  if (row.status !== "preparing") {
    throw new ApiError(409, "invalid_import_state", "导入任务状态已变化");
  }
  if (row.execution_token !== executionToken) {
    throw new ApiError(409, "import_execution_fenced", "导入处理执行权已转移");
  }
}

export async function markImportFailed(
  id: string,
  error: unknown,
  executionToken: string
) {
  let failedRowCount: number | null | undefined;
  try {
    failedRowCount = (await pool.query(
      `UPDATE import_session
          SET status='failed', execution_token=NULL, raw_token=NULL,
              error=$2, updated_at=now()
        WHERE id=$1
          AND status IN ('materializing','preparing')
          AND execution_token=$3::uuid`,
      [id, errorMessage(error), executionToken]
    )).rowCount;
  } catch {
    // The UPDATE may have committed before the client observed the failure.
  }
  if (failedRowCount) {
    clearImportPhase(id);
    await notifyImportStatus(id).catch(() => undefined);
    return true;
  }

  try {
    const current = (await pool.query(
      "SELECT status FROM import_session WHERE id=$1",
      [id]
    )).rows[0] as { status: ImportStatus } | undefined;
    const safeToClean = !current
      || ["failed", "cancelled"].includes(current.status);
    if (current?.status === "failed") {
      clearImportPhase(id);
      await notifyImportStatus(id).catch(() => undefined);
    }
    return safeToClean;
  } catch {
    return false;
  }
}
