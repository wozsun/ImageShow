import type { Device } from "@imageshow/shared";
import { getInputImageMaxBytes, getInputImageMaxLongEdge } from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { pool } from "../../core/db.ts";
import { ApiError } from "../../core/api-error.ts";
import { contentType, writeStorageBuffer } from "../../storage/storage.ts";
import { detectBrightness } from "../brightness.ts";
import { deviceFromDimensions } from "../classification.ts";
import { createThumbnail, probeImageBytes, transcodeStoredImage } from "../processing.ts";
import { getDuplicateImagesByMd5 } from "../read-models/duplicates.ts";
import { runImportPreparation } from "./execution.ts";
import { fetchImportImage, fetchImportImageToFile } from "./fetch.ts";
import {
  assertImportStillPreparing,
  importWasCancelled,
  markImportFailed,
  notifyImportStatus,
  setImportDownloadProgress,
  setImportPhase
} from "./progress.ts";
import {
  cleanupStagedObjects,
  stagingImageKey,
  stagingThumbnailKey
} from "./staging.ts";
import { rawImportPath, removeRawImport } from "./temp-files.ts";
import type {
  ImportMode,
  ImportSessionRow,
  PreparedImportResult,
  PreparedPayload
} from "./types.ts";

type StoredPreparationSession = Pick<
  ImportSessionRow,
  "mode" | "status" | "metadata_payload" | "source_url" | "storage_slug"
>;

type ProxyPreparationSession = Pick<
  ImportSessionRow,
  "metadata_payload" | "source_url" | "storage_slug"
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

async function prepareStoredImageSession(
  id: string,
  mode: Extract<ImportMode, "upload" | "download">,
  signal: AbortSignal
): Promise<PreparedImportResult> {
  const session = (await pool.query(
    `SELECT mode, status, metadata_payload, source_url, storage_slug
       FROM import_session
      WHERE id=$1`,
    [id]
  )).rows[0] as StoredPreparationSession | undefined;
  if (!session || session.mode !== mode || session.status !== "preparing") {
    throw new ApiError(409, "invalid_import_state", "导入任务不能进入处理阶段");
  }

  const sourcePath = rawImportPath(id);
  try {
    if (signal.aborted) throw new ApiError(409, "import_cancelled", "导入已取消");
    const runtime = getRuntimeConfig();
    setImportPhase(id, "normalizing", "校验格式、压缩原图并生成缩略图");
    const normalized = await transcodeStoredImage(sourcePath, {
      ...runtime.normalize,
      max_long_edge: Math.min(runtime.normalize.max_long_edge, getInputImageMaxLongEdge())
    });
    if (signal.aborted) throw new ApiError(409, "import_cancelled", "导入已取消");
    await assertImportStillPreparing(id);

    setImportPhase(id, "detecting", "确认图片尺寸、设备类型和明暗");
    const detectedDevice = requiredDeviceFromDimensions(
      normalized.width,
      normalized.height
    );
    const detectedBrightness = await detectBrightness(normalized.thumbnail);

    setImportPhase(id, "staging", "写入处理后的图片和缩略图");
    const writes = await Promise.allSettled([
      writeStorageBuffer(
        "_uploads",
        stagingImageKey(id),
        normalized.processed,
        contentType(normalized.ext),
        session.storage_slug
      ),
      writeStorageBuffer(
        "_uploads",
        stagingThumbnailKey(id),
        normalized.thumbnail,
        "image/webp",
        session.storage_slug
      )
    ]);
    const writeFailure = writes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (writeFailure) throw writeFailure.reason;

    const payload: PreparedPayload = {
      ...session.metadata_payload,
      mode,
      source_url: session.source_url,
      prepared_thumbnail_key: stagingThumbnailKey(id),
      original_size: normalized.sourceSize,
      original_width: normalized.sourceWidth,
      original_height: normalized.sourceHeight,
      width: normalized.width,
      height: normalized.height,
      ext: normalized.ext,
      md5: normalized.md5,
      size: normalized.size,
      thumbnail_size: normalized.thumbnail.byteLength,
      quality: normalized.quality,
      transcoded: normalized.transcoded,
      detected_device: detectedDevice,
      detected_brightness: detectedBrightness
    };
    const updated = await pool.query(
      `UPDATE import_session
       SET status='ready', prepared_payload=$2::jsonb, error='', updated_at=now()
       WHERE id=$1 AND status='preparing'`,
      [id, JSON.stringify(payload)]
    );
    if (!updated.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
    await notifyImportStatus(id);
    return preparedResult(id, session.storage_slug, payload);
  } catch (error) {
    await cleanupStagedObjects(id, session.storage_slug).catch(() => undefined);
    await markImportFailed(id, error);
    throw error;
  } finally {
    await removeRawImport(id);
  }
}

async function prepareUploadSession(id: string, signal: AbortSignal) {
  const prepared = await pool.query(
    "UPDATE import_session SET status='preparing', updated_at=now() WHERE id=$1 AND mode='upload' AND status='receiving'",
    [id]
  );
  if (!prepared.rowCount) {
    throw new ApiError(409, "invalid_import_state", "上传任务尚未接收文件");
  }
  await notifyImportStatus(id);
  return prepareStoredImageSession(id, "upload", signal);
}

async function prepareDownloadSession(id: string, signal: AbortSignal) {
  const claimed = await pool.query(
    "UPDATE import_session SET status='receiving', updated_at=now() WHERE id=$1 AND mode='download' AND status='created' RETURNING source_url",
    [id]
  );
  if (!claimed.rowCount) {
    throw new ApiError(409, "invalid_import_state", "下载导入任务不能开始");
  }
  await notifyImportStatus(id);

  const url = String(claimed.rows[0].source_url ?? "");
  try {
    setImportPhase(id, "downloading", "服务端下载原图");
    let lastProgressUpdateAt = 0;
    await fetchImportImageToFile(
      url,
      rawImportPath(id),
      getInputImageMaxBytes(),
      signal,
      (progress) => {
        const now = Date.now();
        if (progress < 100 && lastProgressUpdateAt && now - lastProgressUpdateAt < 250) return;
        lastProgressUpdateAt = now;
        setImportDownloadProgress(id, progress);
      }
    );
    setImportPhase(id, "processing", "下载完成，进入图片处理");
    const prepared = await pool.query(
      "UPDATE import_session SET status='preparing', updated_at=now() WHERE id=$1 AND status='receiving'",
      [id]
    );
    if (!prepared.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
    await notifyImportStatus(id);
    return prepareStoredImageSession(id, "download", signal);
  } catch (error) {
    await removeRawImport(id);
    await markImportFailed(id, error);
    throw error;
  }
}

async function prepareProxySession(id: string, signal: AbortSignal) {
  const claimed = await pool.query(
    `UPDATE import_session
        SET status='preparing', updated_at=now()
      WHERE id=$1 AND mode='proxy' AND status='created'
      RETURNING metadata_payload, source_url, storage_slug`,
    [id]
  );
  if (!claimed.rowCount) {
    throw new ApiError(409, "invalid_import_state", "代理链接导入任务不能开始");
  }
  await notifyImportStatus(id);
  const session = claimed.rows[0] as ProxyPreparationSession;

  try {
    setImportPhase(id, "probing", "下载外链用于探测尺寸和生成缩略图");
    const buffer = await fetchImportImage(
      session.source_url,
      getInputImageMaxBytes(),
      signal
    );
    const probe = await probeImageBytes(buffer);
    const thumbnail = await createThumbnail(buffer);
    const detectedDevice = requiredDeviceFromDimensions(probe.width, probe.height);
    const detectedBrightness = await detectBrightness(thumbnail);
    await writeStorageBuffer(
      "_uploads",
      stagingThumbnailKey(id),
      thumbnail,
      "image/webp",
      session.storage_slug
    );

    const payload: PreparedPayload = {
      ...session.metadata_payload,
      mode: "proxy",
      source_url: session.source_url,
      prepared_thumbnail_key: stagingThumbnailKey(id),
      original_size: probe.size,
      original_width: probe.width,
      original_height: probe.height,
      width: probe.width,
      height: probe.height,
      ext: probe.ext,
      md5: probe.md5,
      size: probe.size,
      thumbnail_size: thumbnail.byteLength,
      quality: null,
      transcoded: false,
      detected_device: detectedDevice,
      detected_brightness: detectedBrightness
    };
    const updated = await pool.query(
      `UPDATE import_session
       SET status='ready', prepared_payload=$2::jsonb, error='', updated_at=now()
       WHERE id=$1 AND status='preparing'`,
      [id, JSON.stringify(payload)]
    );
    if (!updated.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
    await notifyImportStatus(id);
    return preparedResult(id, session.storage_slug, payload);
  } catch (error) {
    await cleanupStagedObjects(id, session.storage_slug).catch(() => undefined);
    await markImportFailed(id, error);
    throw error;
  }
}

export async function prepareImportSession(id: string) {
  const session = (await pool.query(
    `SELECT mode, status, storage_slug, prepared_payload
       FROM import_session
      WHERE id=$1`,
    [id]
  )).rows[0] as Pick<
    ImportSessionRow,
    "mode" | "status" | "storage_slug" | "prepared_payload"
  > | undefined;
  if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
  if (session.status === "ready") {
    return preparedResult(
      id,
      session.storage_slug,
      session.prepared_payload as PreparedPayload
    );
  }
  if (session.status === "finalized") {
    throw new ApiError(409, "import_finalized", "导入任务已完成");
  }
  if (await importWasCancelled(id)) {
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }

  return runImportPreparation(id, session.mode, (signal) => {
    if (session.mode === "upload") return prepareUploadSession(id, signal);
    if (session.mode === "download") return prepareDownloadSession(id, signal);
    return prepareProxySession(id, signal);
  });
}
