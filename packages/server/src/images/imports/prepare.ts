import type { Device } from "@imageshow/shared";
import { getInputImageMaxLongEdge } from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { pool } from "../../core/db.ts";
import { ApiError } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { contentType, writeStorageBuffer } from "../../storage/storage.ts";
import { detectBrightness } from "../brightness.ts";
import { deviceFromDimensions } from "../classification.ts";
import {
  sha256Buffer,
  transcodeStoredImage
} from "../processing.ts";
import { getDuplicateImagesByMd5 } from "../read-models/duplicates.ts";
import { runImportPreparation } from "./execution.ts";
import { recoverCompletedMaterialization } from "./materialize.ts";
import {
  assertImportStillPreparing,
  importWasCancelled,
  markImportFailed,
  notifyImportStatus,
  setImportPhase
} from "./progress.ts";
import {
  cleanupStagedAttempt,
  cleanupStagedObjects,
  stagingImageKey,
  stagingThumbnailKey
} from "./staging.ts";
import {
  rawImportAttemptPath,
  rawImportPath,
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

function requiredDeviceFromDimensions(width: number, height: number): Device {
  return deviceFromDimensions(width, height) ?? "pc";
}

async function preparedResult(
  id: string,
  storageSlug: string,
  payload: PreparedPayload
): Promise<PreparedImportResult> {
  const duplicates = await getDuplicateImagesByMd5(payload.md5);
  return {
    id,
    preview_url: `/api/admin/imports/${id}/preview`,
    preview_full_url: `/api/admin/imports/${id}/preview/full`,
    width: payload.width,
    height: payload.height,
    original_width: payload.original_width,
    original_height: payload.original_height,
    md5: payload.md5,
    original_size: payload.original_size,
    size: payload.size,
    quality: payload.quality,
    transcoded: payload.transcoded,
    detected_device: payload.detected_device,
    detected_brightness: payload.detected_brightness,
    storage_slug: storageSlug,
    duplicates
  };
}

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
  ) {
    throw new ApiError(409, "invalid_import_state", "导入任务不能进入处理阶段");
  }

  const sourcePath = session.raw_token
    ? rawImportAttemptPath(id, session.raw_token)
    : rawImportPath(id);
  const preparationAttempt = randomUuidV7();
  const preparedImageKey = stagingImageKey(id, preparationAttempt);
  const preparedThumbnailKey = stagingThumbnailKey(id, preparationAttempt);
  let payload: PreparedPayload;
  let result: PreparedImportResult;
  try {
    signal.throwIfAborted();
    const runtime = getRuntimeConfig();
    setImportPhase(id, "normalizing", "校验格式、压缩原图并生成缩略图");
    const normalized = await transcodeStoredImage(sourcePath, {
      ...runtime.normalize,
      max_long_edge: Math.min(runtime.normalize.max_long_edge, getInputImageMaxLongEdge())
    });
    signal.throwIfAborted();
    await assertImportStillPreparing(id, executionToken);

    setImportPhase(id, "detecting", "确认图片尺寸、设备类型和明暗");
    const detectedDevice = requiredDeviceFromDimensions(
      normalized.width,
      normalized.height
    );
    const detectedBrightness = await detectBrightness(normalized.thumbnail);
    signal.throwIfAborted();

    setImportPhase(id, "staging", "写入处理后的图片和缩略图");
    const writes = await Promise.allSettled([
      writeStorageBuffer(
        "_uploads",
        preparedImageKey,
        normalized.processed,
        contentType(normalized.ext),
        session.storage_slug
      ),
      writeStorageBuffer(
        "_uploads",
        preparedThumbnailKey,
        normalized.thumbnail,
        "image/webp",
        session.storage_slug
      )
    ]);
    const writeFailure = writes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (writeFailure) throw writeFailure.reason;
    signal.throwIfAborted();

    payload = {
      ...session.metadata_payload,
      mode,
      source_url: session.source_url,
      prepared_image_key: preparedImageKey,
      prepared_thumbnail_key: preparedThumbnailKey,
      original_size: normalized.sourceSize,
      original_width: normalized.sourceWidth,
      original_height: normalized.sourceHeight,
      width: normalized.width,
      height: normalized.height,
      ext: normalized.ext,
      md5: normalized.md5,
      prepared_image_sha256: sha256Buffer(normalized.processed),
      prepared_thumbnail_sha256: sha256Buffer(normalized.thumbnail),
      size: normalized.size,
      thumbnail_size: normalized.thumbnail.byteLength,
      quality: normalized.quality,
      transcoded: normalized.transcoded,
      detected_device: detectedDevice,
      detected_brightness: detectedBrightness
    };
    result = await preparedResult(id, session.storage_slug, payload);
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
  const result = await preparedResult(
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
