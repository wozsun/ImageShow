import { getInputImageMaxBytes } from "../../config/app-settings.ts";
import { pool } from "../../core/db.ts";
import { ApiError } from "../../core/api-error.ts";
import { runImportMaterialization } from "./execution.ts";
import { fetchImportImageToFile } from "./fetch.ts";
import {
  markImportFailed,
  notifyImportStatus,
  setImportDownloadProgress,
  setImportPhase
} from "./progress.ts";
import {
  rawImportExists,
  rawImportPath,
  removeRawImport,
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
    "SELECT mode, status FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as Pick<ImportSessionRow, "mode" | "status"> | undefined;
}

async function finishMaterialization(id: string) {
  let finalizationError: unknown;
  try {
    const received = await pool.query(
      `UPDATE import_session
       SET status='received', error='', updated_at=now()
       WHERE id=$1 AND status='materializing'`,
      [id]
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
    await notifyImportStatus(id).catch(() => undefined);
    return;
  }

  if (await markImportFailed(id, finalizationError)) {
    await removeRawImport(id);
  }
  throw finalizationError;
}

export async function recoverCompletedMaterialization(
  id: string,
  mode: ImportMode
) {
  const existing = await existingMaterializationState(id);
  if (!existing) throw new ApiError(404, "not_found", "导入任务不存在");
  if (existing.mode !== mode) {
    throw new ApiError(409, "invalid_import_state", "导入任务素材化模式不匹配");
  }
  if (publishedMaterializationStatuses.has(existing.status)) return true;
  if (existing.status === "materializing" && await rawImportExists(id)) {
    await finishMaterialization(id);
    return true;
  }
  return false;
}

export async function receiveImportFile(
  id: string,
  body: ReadableStream<Uint8Array> | null,
  requestSignal?: AbortSignal
) {
  return runImportMaterialization(id, "upload", async (internalSignal) => {
    if (await recoverCompletedMaterialization(id, "upload")) return;
    const claimed = await pool.query(
      `UPDATE import_session
       SET status='materializing', updated_at=now()
       WHERE id=$1 AND mode='upload' AND status IN ('created','materializing')
       RETURNING expected_size`,
      [id]
    );
    if (!claimed.rowCount) {
      throw new ApiError(409, "invalid_import_state", "导入任务不能进入素材化阶段");
    }
    if (!body) {
      const error = new ApiError(400, "empty_body", "Empty body");
      if (await markImportFailed(id, error)) await removeRawImport(id);
      throw error;
    }
    await notifyImportStatus(id).catch(() => undefined);

    try {
      setImportPhase(id, "uploading", "服务端接收上传文件");
      await writeRawImport(
        id,
        body,
        Number(claimed.rows[0].expected_size),
        combinedSignal(internalSignal, requestSignal)
      );
    } catch (error) {
      if (await markImportFailed(id, error)) await removeRawImport(id);
      throw error;
    }
    await finishMaterialization(id);
  }, requestSignal);
}

export async function materializeDownloadSession(
  id: string,
  requestSignal?: AbortSignal
) {
  return runImportMaterialization(id, "download", async (internalSignal) => {
    if (await recoverCompletedMaterialization(id, "download")) return;
    const claimed = await pool.query(
      `UPDATE import_session
       SET status='materializing', updated_at=now()
       WHERE id=$1 AND mode='download' AND status IN ('created','materializing')
       RETURNING source_url`,
      [id]
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
        rawImportPath(id),
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
      if (await markImportFailed(id, error)) await removeRawImport(id);
      throw error;
    }
    await finishMaterialization(id);
  }, requestSignal);
}
