import { randomUUID } from "node:crypto";
import { appConfig } from "@imageshow/shared";
import { pool } from "../../core/database-pools.ts";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { redis } from "../../core/redis-client.ts";
import type { ImportStatus } from "@imageshow/shared/browser";
import {
  clearImportPhase,
  notifyImportStatus
} from "./status.ts";

export type ImportCancellationMarker = Readonly<{
  id: string;
  generation: string;
  value: string;
}>;

type StoredImportCancellationMarker = ImportCancellationMarker & {
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
};

const cancelledImports = new Map<string, StoredImportCancellationMarker>();
const importLeaseHeartbeatMs = Math.max(
  1_000,
  Math.min(30_000, Math.floor(appConfig.uploadTtlSeconds * 1_000 / 3))
);
const clearOwnedCancellationScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

function cancelledImportKey(id: string) {
  return `imageshow:import-cancelled:${id}`;
}

function markerFromValue(id: string, value: string) {
  try {
    const parsed = JSON.parse(value) as {
      generation?: unknown;
      token?: unknown;
    };
    if (
      typeof parsed.generation !== "string"
      || !parsed.generation
      || typeof parsed.token !== "string"
      || !parsed.token
    ) {
      return undefined;
    }
    return {
      id,
      generation: parsed.generation,
      value
    } satisfies ImportCancellationMarker;
  } catch {
    return undefined;
  }
}

function clearLocalCancellationValue(id: string, value: string) {
  const marker = cancelledImports.get(id);
  if (marker?.value !== value) return;
  clearTimeout(marker.expiryTimer);
  cancelledImports.delete(id);
}

function activeLocalCancellation(id: string) {
  const marker = cancelledImports.get(id);
  if (!marker) return undefined;
  if (marker.expiresAt > Date.now()) return marker;
  clearLocalCancellationValue(id, marker.value);
  return undefined;
}

async function clearRedisCancellationValue(id: string, value: string) {
  await redis.eval(
    clearOwnedCancellationScript,
    1,
    cancelledImportKey(id),
    value
  ).catch(() => undefined);
}

async function importGenerationIsCurrent(id: string, generation: string) {
  return Boolean((await pool.query(
    `SELECT 1
       FROM import_session
      WHERE id=$1
        AND created_at=$2::timestamptz`,
    [id, generation]
  )).rowCount);
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

export async function findImportCancellation(
  id: string,
  generation: string
) {
  const localMarker = activeLocalCancellation(id);
  if (localMarker?.generation === generation) return localMarker;
  let generationIsCurrent: Promise<boolean> | undefined;
  const canClearMismatchedMarker = () => {
    generationIsCurrent ??= importGenerationIsCurrent(id, generation)
      .catch(() => false);
    return generationIsCurrent;
  };
  if (localMarker && await canClearMismatchedMarker()) {
    await clearImportCancelled(localMarker);
  }

  const value = await redis.get(cancelledImportKey(id)).catch(() => null);
  if (!value) return undefined;
  const marker = markerFromValue(id, value);
  if (!marker || marker.generation !== generation) {
    // Only the generation still present in PostgreSQL may discard a
    // mismatched derived marker. A fenced old executor must not remove a
    // newer cancellation published for a replacement session.
    if (await canClearMismatchedMarker()) {
      await clearRedisCancellationValue(id, value);
    }
    return undefined;
  }
  return marker;
}

export async function importWasCancelled(
  id: string,
  generation: string
) {
  return Boolean(await findImportCancellation(id, generation));
}

export async function markImportCancelled(
  id: string,
  generation: string
) {
  clearImportPhase(id);
  const value = JSON.stringify({
    generation,
    token: randomUUID()
  });
  const marker = {
    id,
    generation,
    value
  } satisfies ImportCancellationMarker;
  const expiresAt = Date.now() + appConfig.uploadTtlSeconds * 1_000;
  const expiryTimer = setTimeout(() => {
    clearLocalCancellationValue(id, value);
  }, appConfig.uploadTtlSeconds * 1_000);
  expiryTimer.unref();
  const previous = cancelledImports.get(id);
  if (previous) clearTimeout(previous.expiryTimer);
  cancelledImports.set(id, {
    ...marker,
    expiresAt,
    expiryTimer
  });
  await redis
    .set(
      cancelledImportKey(id),
      value,
      "EX",
      appConfig.uploadTtlSeconds
    )
    .catch(() => undefined);
  return marker;
}

export async function clearImportCancelled(
  marker: ImportCancellationMarker
) {
  clearLocalCancellationValue(marker.id, marker.value);
  await clearRedisCancellationValue(marker.id, marker.value);
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
