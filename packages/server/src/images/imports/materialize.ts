import { getInputImageMaxBytes } from "../../config/app-settings.ts";
import { pool } from "../../core/db.ts";
import { ApiError } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { runImportMaterialization } from "./execution.ts";
import { fetchImportImageToFile } from "./fetch.ts";
import {
  markImportFailed,
  notifyImportStatus,
  setImportDownloadProgress,
  setImportPhase
} from "./progress.ts";
import {
  adoptLegacyRawImport,
  rawImportAttemptPath,
  rawImportExists,
  rawImportPartPath,
  removeRawImport,
  removeRawImportAttempt,
  writeRawImport
} from "./temp-files.ts";
import type { ImportMode, ImportSessionRow, ImportStatus } from "./types.ts";

const publishedMaterializationStatuses = new Set<ImportStatus>([
  "received",
  "preparing",
  "ready",
  "committing",
  "finalized"
]);

function combinedSignal(internal: AbortSignal, external?: AbortSignal) {
  return external ? AbortSignal.any([internal, external]) : internal;
}

async function existingMaterializationState(id: string) {
  return (await pool.query(
    `SELECT mode, status, execution_token, raw_token
       FROM import_session
      WHERE id=$1`,
    [id]
  )).rows[0] as Pick<
    ImportSessionRow,
    "mode" | "status" | "execution_token" | "raw_token"
  > | undefined;
}

async function throwAbortedMaterialization(
  id: string,
  executionToken: string,
  signal: AbortSignal,
  fallback: unknown
): Promise<never> {
  try {
    const current = await existingMaterializationState(id);
    if (!current || ["failed", "cancelled"].includes(current.status)) {
      await removeRawImport(id);
    } else if (
      current.execution_token !== executionToken
      && current.raw_token !== executionToken
    ) {
      await removeRawImportAttempt(id, executionToken);
    }
  } catch {
    // Preserve a complete raw file whenever PostgreSQL cannot prove the
    // session is terminal. A retry or orphan cleanup can resolve ownership.
  }
  throw signal.reason ?? fallback;
}

async function finishMaterialization(
  id: string,
  executionToken: string,
  signal?: AbortSignal
) {
  let finalizationError: unknown;
  try {
    signal?.throwIfAborted();
    const received = await pool.query(
      `UPDATE import_session
       SET status='received', execution_token=NULL, raw_token=$2::uuid,
           error='', updated_at=now()
       WHERE id=$1 AND status='materializing' AND execution_token=$2::uuid`,
      [id, executionToken]
    );
    if (!received.rowCount) {
      finalizationError = new ApiError(409, "import_cancelled", "导入已取消");
    }
  } catch (error) {
    finalizationError = error;
  }

  if (!finalizationError) {
    await notifyImportStatus(id).catch(() => undefined);
    return;
  }

  let current: Awaited<ReturnType<typeof existingMaterializationState>>;
  try {
    current = await existingMaterializationState(id);
  } catch {
    // The UPDATE may already have committed before its connection failed. Keep
    // the complete raw file whenever PostgreSQL cannot resolve ownership.
    throw finalizationError;
  }
  if (current && publishedMaterializationStatuses.has(current.status)) {
    if (current.raw_token === executionToken) {
      await notifyImportStatus(id).catch(() => undefined);
      return;
    }
    if (["ready", "committing", "finalized"].includes(current.status)) {
      // Preparation has already stopped depending on raw. A fenced executor
      // may have published its private attempt after the successor performed
      // the broad ready-state cleanup, so remove that attempt explicitly.
      await removeRawImportAttempt(id, executionToken).catch(() => undefined);
      await notifyImportStatus(id).catch(() => undefined);
      return;
    }
    await removeRawImportAttempt(id, executionToken).catch(() => undefined);
    throw new ApiError(409, "import_execution_fenced", "导入素材化执行权已转移");
  }

  if (current?.status === "materializing"
    && current.execution_token !== executionToken) {
    await removeRawImportAttempt(id, executionToken).catch(() => undefined);
    throw new ApiError(409, "import_execution_fenced", "导入素材化执行权已转移");
  }

  if (await markImportFailed(id, finalizationError, executionToken)) {
    await removeRawImport(id);
  } else if (current?.status === "cancelled") {
    await removeRawImport(id).catch(() => undefined);
  } else {
    await removeRawImportAttempt(id, executionToken).catch(() => undefined);
  }
  throw finalizationError;
}

export async function recoverCompletedMaterialization(
  id: string,
  mode: ImportMode,
  signal?: AbortSignal
) {
  const existing = await existingMaterializationState(id);
  if (!existing) throw new ApiError(404, "not_found", "导入任务不存在");
  if (existing.mode !== mode) {
    throw new ApiError(409, "invalid_import_state", "导入任务素材化模式不匹配");
  }
  if (publishedMaterializationStatuses.has(existing.status)) return true;
  if (existing.status === "materializing") {
    signal?.throwIfAborted();
    if (
      existing.execution_token
      && await rawImportExists(id, existing.execution_token)
    ) {
      await finishMaterialization(id, existing.execution_token, signal);
      return true;
    }
    // Rows created by pre-fencing versions may have published the legacy
    // shared raw name. Adopt it into a token-owned name before publication.
    if (!existing.execution_token && await rawImportExists(id)) {
      const executionToken = randomUuidV7();
      const claimed = await pool.query(
        `UPDATE import_session
            SET execution_token=$3::uuid, updated_at=now()
          WHERE id=$1 AND mode=$2 AND status='materializing'
            AND execution_token IS NULL`,
        [id, mode, executionToken]
      );
      if (!claimed.rowCount) return false;
      await adoptLegacyRawImport(id, executionToken);
      await finishMaterialization(id, executionToken, signal);
      return true;
    }
  }
  return false;
}

export async function receiveImportFile(
  id: string,
  body: ReadableStream<Uint8Array> | null,
  requestSignal?: AbortSignal
) {
  return runImportMaterialization(id, "upload", async (internalSignal) => {
    if (await recoverCompletedMaterialization(id, "upload", internalSignal)) return;
    const executionToken = randomUuidV7();
    const claimed = await pool.query(
      `UPDATE import_session
       SET status='materializing', execution_token=$2::uuid, updated_at=now()
       WHERE id=$1 AND mode='upload' AND status IN ('created','materializing')
       RETURNING expected_size`,
      [id, executionToken]
    );
    if (!claimed.rowCount) {
      throw new ApiError(409, "invalid_import_state", "导入任务不能进入素材化阶段");
    }
    if (!body) {
      const error = new ApiError(400, "empty_body", "Empty body");
      if (await markImportFailed(id, error, executionToken)) await removeRawImport(id);
      throw error;
    }
    await notifyImportStatus(id).catch(() => undefined);

    try {
      setImportPhase(id, "uploading", "服务端接收上传文件");
      await writeRawImport(
        id,
        body,
        Number(claimed.rows[0].expected_size),
        executionToken,
        combinedSignal(internalSignal, requestSignal)
      );
    } catch (error) {
      if (internalSignal.aborted) {
        return throwAbortedMaterialization(
          id,
          executionToken,
          internalSignal,
          error
        );
      }
      if (await markImportFailed(id, error, executionToken)) {
        await removeRawImport(id);
      } else {
        await removeRawImportAttempt(id, executionToken).catch(() => undefined);
      }
      throw error;
    }
    if (internalSignal.aborted) {
      return throwAbortedMaterialization(
        id,
        executionToken,
        internalSignal,
        new ApiError(409, "import_cancelled", "导入已取消")
      );
    }
    await finishMaterialization(id, executionToken, internalSignal);
  }, requestSignal);
}

export async function materializeDownloadSession(
  id: string,
  requestSignal?: AbortSignal
) {
  return runImportMaterialization(id, "download", async (internalSignal) => {
    if (await recoverCompletedMaterialization(id, "download", internalSignal)) return;
    const executionToken = randomUuidV7();
    const claimed = await pool.query(
      `UPDATE import_session
       SET status='materializing', execution_token=$2::uuid, updated_at=now()
       WHERE id=$1 AND mode='download' AND status IN ('created','materializing')
       RETURNING source_url`,
      [id, executionToken]
    );
    if (!claimed.rowCount) {
      throw new ApiError(409, "invalid_import_state", "导入任务不能进入素材化阶段");
    }
    await notifyImportStatus(id).catch(() => undefined);

    const url = String(claimed.rows[0].source_url ?? "");
    try {
      setImportPhase(id, "downloading", "服务端下载原图");
      let lastProgressUpdateAt = 0;
      await fetchImportImageToFile(
        url,
        rawImportAttemptPath(id, executionToken),
        rawImportPartPath(id, executionToken),
        getInputImageMaxBytes(),
        combinedSignal(internalSignal, requestSignal),
        (progress) => {
          const now = Date.now();
          if (
            progress < 100
            && lastProgressUpdateAt
            && now - lastProgressUpdateAt < 250
          ) return;
          lastProgressUpdateAt = now;
          setImportDownloadProgress(id, progress);
        }
      );
    } catch (error) {
      if (internalSignal.aborted) {
        return throwAbortedMaterialization(
          id,
          executionToken,
          internalSignal,
          error
        );
      }
      if (await markImportFailed(id, error, executionToken)) {
        await removeRawImport(id);
      } else {
        await removeRawImportAttempt(id, executionToken).catch(() => undefined);
      }
      throw error;
    }
    if (internalSignal.aborted) {
      return throwAbortedMaterialization(
        id,
        executionToken,
        internalSignal,
        new ApiError(409, "import_cancelled", "导入已取消")
      );
    }
    await finishMaterialization(id, executionToken, internalSignal);
  }, requestSignal);
}
