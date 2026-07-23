import { pool } from "../../core/db.ts";
import { ApiError } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { runImportPreparation } from "./execution.ts";
import { recoverCompletedMaterialization } from "./materialize.ts";
import {
  importWasCancelled,
  markImportFailed
} from "./lifecycle.ts";
import { notifyImportStatus } from "./status.ts";
import {
  preparedImportResult,
  prepareImportArtifacts
} from "./prepare-artifacts.ts";
import {
  cleanupStagedAttempt,
  cleanupStagedObjects
} from "./staging.ts";
import {
  stagingImageKey,
  stagingThumbnailKey
} from "./staging-keys.ts";
import {
  rawImportAttemptPath,
  removeRawImport
} from "./temp-files.ts";
import type {
  ImportMode,
  ImportSessionRow,
  ImportStatus,
  PreparedImportResult,
  PreparedPayload
} from "./types.ts";

type StoredPreparationSession = Pick<
  ImportSessionRow,
  | "mode"
  | "status"
  | "metadata_payload"
  | "source_url"
  | "storage_slug"
  | "execution_token"
  | "raw_token"
>;

const publishedPreparationStatuses = new Set<ImportStatus>([
  "ready",
  "committing",
  "finalized"
]);

async function finishPreparation(
  id: string,
  storageSlug: string,
  payload: PreparedPayload,
  executionToken: string,
  signal: AbortSignal
) {
  let finalizationError: unknown;
  try {
    signal.throwIfAborted();
    const updated = await pool.query(
      `UPDATE import_session
       SET status='ready', prepared_payload=$2::jsonb, execution_token=NULL,
           raw_token=NULL, error='', updated_at=now()
       WHERE id=$1 AND status='preparing' AND execution_token=$3::uuid`,
      [id, JSON.stringify(payload), executionToken]
    );
    if (!updated.rowCount) {
      finalizationError = new ApiError(409, "import_cancelled", "导入已取消");
    }
  } catch (error) {
    finalizationError = error;
  }

  if (!finalizationError) {
    await notifyImportStatus(id).catch(() => undefined);
    return;
  }

  let current: Pick<
    ImportSessionRow,
    "status" | "execution_token" | "prepared_payload"
  > | undefined;
  try {
    current = (await pool.query(
      `SELECT status, execution_token, prepared_payload
         FROM import_session
        WHERE id=$1`,
      [id]
    )).rows[0] as Pick<
      ImportSessionRow,
      "status" | "execution_token" | "prepared_payload"
    > | undefined;
  } catch {
    // The ready UPDATE may already have committed. Preserve raw and prepared
    // objects until PostgreSQL can resolve the authoritative state.
    throw finalizationError;
  }
  if (current && publishedPreparationStatuses.has(current.status)) {
    const published = current.prepared_payload as Partial<PreparedPayload>;
    if (
      published.prepared_image_key === payload.prepared_image_key
      && published.prepared_thumbnail_key === payload.prepared_thumbnail_key
    ) {
      await notifyImportStatus(id).catch(() => undefined);
      return;
    }
    await cleanupStagedAttempt(
      payload.prepared_image_key,
      payload.prepared_thumbnail_key,
      storageSlug
    ).catch(() => undefined);
    throw new ApiError(409, "import_execution_fenced", "导入处理执行权已转移");
  }

  if (current?.status === "preparing"
    && current.execution_token !== executionToken) {
    await cleanupStagedAttempt(
      payload.prepared_image_key,
      payload.prepared_thumbnail_key,
      storageSlug
    ).catch(() => undefined);
    throw new ApiError(409, "import_execution_fenced", "导入处理执行权已转移");
  }

  const removeRaw = await markImportFailed(id, finalizationError, executionToken);
  await cleanupStagedAttempt(
    payload.prepared_image_key,
    payload.prepared_thumbnail_key,
    storageSlug
  ).catch(() => undefined);
  if (removeRaw) await removeRawImport(id).catch(() => undefined);
  throw finalizationError;
}

async function prepareStoredImageSession(
  id: string,
  mode: Extract<ImportMode, "upload" | "download">,
  executionToken: string,
  signal: AbortSignal
): Promise<PreparedImportResult> {
  const session = (await pool.query(
    `SELECT mode, status, metadata_payload, source_url, storage_slug,
            execution_token, raw_token
       FROM import_session
      WHERE id=$1`,
    [id]
  )).rows[0] as StoredPreparationSession | undefined;
  if (
    !session
    || session.mode !== mode
    || session.status !== "preparing"
    || session.execution_token !== executionToken
    || !session.raw_token
  ) {
    throw new ApiError(409, "invalid_import_state", "导入任务不能进入处理阶段");
  }

  const sourcePath = rawImportAttemptPath(id, session.raw_token);
  const preparationAttempt = randomUuidV7();
  const preparedImageKey = stagingImageKey(id, preparationAttempt);
  const preparedThumbnailKey = stagingThumbnailKey(id, preparationAttempt);
  let payload: PreparedPayload;
  let result: PreparedImportResult;
  try {
    signal.throwIfAborted();
    const prepared = await prepareImportArtifacts({
      id,
      mode,
      executionToken,
      sourcePath,
      sourceUrl: session.source_url,
      storageSlug: session.storage_slug,
      metadata: session.metadata_payload,
      preparedImageKey,
      preparedThumbnailKey,
      signal
    });
    payload = prepared.payload;
    result = prepared.result;
  } catch (error) {
    if (signal.aborted) {
      await cleanupStagedAttempt(
        preparedImageKey,
        preparedThumbnailKey,
        session.storage_slug
      ).catch(() => undefined);
      throw signal.reason ?? error;
    }
    const removeRaw = await markImportFailed(id, error, executionToken);
    await cleanupStagedAttempt(
      preparedImageKey,
      preparedThumbnailKey,
      session.storage_slug
    ).catch(() => undefined);
    if (removeRaw) await removeRawImport(id).catch(() => undefined);
    throw error;
  }

  await finishPreparation(
    id,
    session.storage_slug,
    payload,
    executionToken,
    signal
  );
  await removeRawImport(id).catch(() => undefined);
  return result;
}

type PreparationSessionState = Pick<
  ImportSessionRow,
  | "mode"
  | "status"
  | "storage_slug"
  | "prepared_payload"
  | "execution_token"
  | "raw_token"
>;

async function preparationSessionState(id: string) {
  return (await pool.query(
    `SELECT mode, status, storage_slug, prepared_payload, execution_token,
            raw_token
       FROM import_session
      WHERE id=$1`,
    [id]
  )).rows[0] as PreparationSessionState | undefined;
}

async function readyPreparationResult(id: string, session: PreparationSessionState) {
  const result = await preparedImportResult(
    id,
    session.storage_slug,
    session.prepared_payload as PreparedPayload
  );
  await removeRawImport(id).catch(() => undefined);
  return result;
}

async function prepareCurrentSession(
  id: string,
  mode: ImportMode,
  signal: AbortSignal
) {
  let session = await preparationSessionState(id);
  if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
  if (session.mode !== mode) {
    throw new ApiError(409, "invalid_import_state", "导入任务处理模式不匹配");
  }
  if (session.status === "ready") return readyPreparationResult(id, session);
  if (session.status === "finalized") {
    throw new ApiError(409, "import_finalized", "导入任务已完成");
  }
  if (await importWasCancelled(id)) {
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }

  if (session.status === "materializing") {
    if (!await recoverCompletedMaterialization(id, mode, signal)) {
      throw new ApiError(409, "invalid_import_state", "导入素材尚未接收完成");
    }
    session = await preparationSessionState(id);
    if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
  }

  const recovering = session.status === "preparing";
  if (session.status !== "received" && !recovering) {
    throw new ApiError(409, "invalid_import_state", "导入素材尚未接收完成");
  }

  const previousStatus = session.status;
  const executionToken = randomUuidV7();
  let claimError: unknown;
  try {
    signal.throwIfAborted();
    const prepared = await pool.query(
      `UPDATE import_session
       SET status='preparing', execution_token=$3::uuid, error='',
           updated_at=now()
       WHERE id=$1 AND mode=$2 AND status=$4`,
      [id, mode, executionToken, previousStatus]
    );
    if (!prepared.rowCount) {
      claimError = new ApiError(
        409,
        "invalid_import_state",
        "导入素材尚未接收完成"
      );
    }
  } catch (error) {
    claimError = error;
  }

  if (claimError) {
    let current: PreparationSessionState | undefined;
    try {
      current = await preparationSessionState(id);
    } catch {
      // The claim may already have committed. Preserve raw and let a retry
      // resolve the authoritative status if PostgreSQL cannot answer now.
      throw claimError;
    }
    if (current?.status === "ready") return readyPreparationResult(id, current);
    if (current?.status !== "preparing"
      || current.execution_token !== executionToken) {
      throw claimError;
    }
    session = current;
  }
  await notifyImportStatus(id).catch(() => undefined);

  if (recovering) {
    // Owning the session advisory lock proves that no live materialize/prepare
    // execution can still publish these attempt-scoped staging objects.
    await cleanupStagedObjects(id, session.storage_slug);
    signal.throwIfAborted();
  }
  return prepareStoredImageSession(id, mode, executionToken, signal);
}

export async function prepareImportSession(id: string, requestSignal?: AbortSignal) {
  const session = await preparationSessionState(id);
  if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
  if (session.status === "ready") return readyPreparationResult(id, session);
  if (session.status === "finalized") {
    throw new ApiError(409, "import_finalized", "导入任务已完成");
  }
  if (await importWasCancelled(id)) {
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }

  return runImportPreparation(id, session.mode, (signal) => {
    return prepareCurrentSession(id, session.mode, signal);
  }, requestSignal);
}
