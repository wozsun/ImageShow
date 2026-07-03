import type { z } from "zod";
import { EventEmitter } from "node:events";
import { appConfig, categoryKey, indexKey, type Brightness, type Device, type ImageExt } from "@imageshow/shared";
import { adjustCategoryCount, pool, upsertCategory, withTransaction } from "../../core/db.js";
import { ApiError, errorMessage } from "../../core/http.js";
import { bumpFolder, invalidateImageReadCaches, invalidateMd5Cache } from "../../core/redis.js";
import { redis } from "../../core/redis.js";
import { getRuntimeConfig } from "../../config/env.js";
import { assertStorageUploadable, getDefaultStorageSlug, getImageMaxLongEdge, getUploadLimitBytes } from "../../config/settings.js";
import { linkDownloadPrepareInput, uploadCreateInput } from "../../core/validation.js";
import { contentType, exists, moveObject, readStorageBuffer, removeObject, writeStorageBuffer } from "../../storage/storage.js";
import { storageObjectKey, thumbnailObjectKey } from "../../storage/image-paths.js";
import { ensureAuthor } from "../../authors/service.js";
import { ensureTheme } from "../../themes/service.js";
import { setImageTags } from "../../tags/service.js";
import { detectBrightness } from "../brightness.js";
import { detectDeviceFromDimensions, transcodeStoredImage } from "../processing.js";
import { publicImage, uploadSessionResponse, type ImageRecord, type UploadSessionRecord } from "../presenter.js";
import { fetchImportImageToFile } from "../link-import/fetch.js";
import { rawImportPath, removeRawImport, writeRawUpload, type RawImportKind } from "./temp-files.js";

type UploadCreateInput = z.infer<typeof uploadCreateInput>;
type DownloadCreateInput = z.infer<typeof linkDownloadPrepareInput>;

export type UploadMetadataOverride = {
  device: Device;
  brightness: Brightness | "auto";
  theme: string;
  author: string;
  title: string;
  description: string;
  source: string;
  original: string;
  tags: string[];
};

type StoredImportMode = "upload" | "download";

type PreparedPayload = UploadMetadataOverride & {
  version: 2;
  import_mode: StoredImportMode;
  source_url?: string;
  prepared_thumbnail_key: string;
  original_size: number;
  original_width: number;
  original_height: number;
  width: number;
  height: number;
  ext: ImageExt;
  md5: string;
  size: number;
  thumbnail_size: number;
  quality: number | null;
  transcoded: boolean;
  detected_device: Device;
  detected_brightness: Brightness;
};

export type PreparedImportResult = {
  id: string;
  preview_url: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  ext: ImageExt;
  md5: string;
  original_size: number;
  size: number;
  quality: number | null;
  transcoded: boolean;
  device: Device;
  brightness: Brightness;
  storage_slug: string;
};

type StoredImportStatusEvent = {
  id: string;
  status: string;
  error: string;
  phase: string;
  message: string;
};

// activeImports 只负责当前进程内的取消与去重；Redis 取消标记覆盖“取消刚发生、请求随后又到”的跨请求竞态。
const activeImports = new Map<string, { controller: AbortController; promise: Promise<PreparedImportResult> }>();
const activeImportPhases = new Map<string, { phase: string; message: string }>();
const importStatusEvents = new EventEmitter();
const cancelledImportKey = (id: string) => `imageshow:stored-import-cancelled:${id}`;
const cancelledImports = new Map<string, number>();

importStatusEvents.setMaxListeners(0);

async function importWasCancelled(id: string) {
  const expires = cancelledImports.get(id) ?? 0;
  if (expires > Date.now()) return true;
  if (expires) cancelledImports.delete(id);
  return Boolean(await redis.get(cancelledImportKey(id)).catch(() => null));
}

async function markImportCancelled(id: string) {
  cancelledImports.set(id, Date.now() + appConfig.uploadTtlSeconds * 1000);
  await redis.set(cancelledImportKey(id), "1", "EX", appConfig.uploadTtlSeconds).catch(() => undefined);
}

function stagingImageKey(id: string) {
  return `${id}.image.webp`;
}

function stagingThumbnailKey(id: string) {
  return `${id}.thumb.webp`;
}

function rawKind(mode: StoredImportMode): RawImportKind {
  return mode === "upload" ? "upload" : "import";
}

function preparedResult(id: string, storageSlug: string, payload: PreparedPayload): PreparedImportResult {
  return {
    id,
    preview_url: `/api/admin/imports/${id}/preview`,
    width: payload.width,
    height: payload.height,
    original_width: payload.original_width,
    original_height: payload.original_height,
    ext: payload.ext,
    md5: payload.md5,
    original_size: payload.original_size,
    size: payload.size,
    quality: payload.quality,
    transcoded: payload.transcoded,
    device: payload.detected_device,
    brightness: payload.detected_brightness,
    storage_slug: storageSlug
  };
}

function setImportPhase(id: string, phase: string, message: string) {
  activeImportPhases.set(id, { phase, message });
  notifyImportStatus(id).catch(() => undefined);
}

function fallbackImportMessage(status: string, mode?: string, error?: string) {
  if (status === "created") return "等待接收原图";
  if (status === "receiving") return mode === "download" ? "服务端下载原图" : "服务端接收上传文件";
  if (status === "preparing") return "标准化图片并生成缩略图";
  if (status === "ready") return "服务端处理完成";
  if (status === "committing") return "写入图库";
  if (status === "finalized") return "已写入图库";
  if (status === "failed") return error || "处理失败";
  if (status === "cancelled") return "已取消";
  return "等待处理";
}

function emitImportStatus(status: StoredImportStatusEvent) {
  importStatusEvents.emit("status", status);
}

function emitCancelledImportStatus(id: string) {
  emitImportStatus({ id, status: "cancelled", error: "", phase: "cancelled", message: "已取消" });
}

async function notifyImportStatus(id: string) {
  emitImportStatus(await getPreparedImportStatusEvent(id));
}

async function runActive(id: string, work: (signal: AbortSignal) => Promise<PreparedImportResult>) {
  if (activeImports.has(id)) throw new ApiError(409, "import_already_running", "导入任务正在处理中");
  const controller = new AbortController();
  const promise = work(controller.signal);
  activeImports.set(id, { controller, promise });
  try {
    return await promise;
  } finally {
    if (activeImports.get(id)?.promise === promise) activeImports.delete(id);
    activeImportPhases.delete(id);
  }
}

async function sessionStillPreparing(id: string) {
  const row = (await pool.query("SELECT status FROM upload_session WHERE id=$1", [id])).rows[0];
  if (!row || row.status === "cancelled") throw new ApiError(409, "import_cancelled", "导入已取消");
  if (row.status !== "preparing") throw new ApiError(409, "invalid_upload_state", "导入任务状态已变化");
}

async function cleanupPreparedObjects(id: string, storageSlug: string) {
  await Promise.all([
    removeObject("_uploads", stagingImageKey(id), storageSlug).catch(() => undefined),
    removeObject("_uploads", stagingThumbnailKey(id), storageSlug).catch(() => undefined)
  ]);
}

async function finishPreparedImport(image: ImageRecord, payload: PreparedPayload) {
  if (payload.tags.length) await setImageTags(image.id, payload.tags);
  await bumpFolder(image.category_key, 1);
  await invalidateMd5Cache(payload.md5);
  await invalidateImageReadCaches();
}

async function prepareRawSession(id: string, mode: StoredImportMode, signal: AbortSignal): Promise<PreparedImportResult> {
  const session = (await pool.query("SELECT * FROM upload_session WHERE id=$1", [id])).rows[0];
  if (!session || session.status !== "preparing" || session.metadata_payload?.import_mode !== mode) {
    throw new ApiError(409, "invalid_upload_state", "导入任务不能进入处理阶段");
  }
  const sourcePath = rawImportPath(rawKind(mode), id);
  try {
    if (signal.aborted) throw new ApiError(409, "import_cancelled", "导入已取消");
    const runtime = getRuntimeConfig();
    setImportPhase(id, "normalizing", "校验格式、压缩原图并生成缩略图");
    // raw 只短暂落在 data/tmp；标准化后的成品和缩略图先写入目标后端的 _uploads，提交时再原子搬到正式目录。
    const normalized = await transcodeStoredImage(sourcePath, {
      ...runtime.normalize,
      max_long_edge: Math.min(runtime.normalize.max_long_edge, await getImageMaxLongEdge())
    });
    if (signal.aborted) throw new ApiError(409, "import_cancelled", "导入已取消");
    await sessionStillPreparing(id);
    setImportPhase(id, "detecting", "检测图片尺寸、设备类型和明暗");
    const brightness = await detectBrightness(normalized.thumbnail);
    const device = detectDeviceFromDimensions(normalized.width, normalized.height);
    setImportPhase(id, "staging", "写入处理后的图片和缩略图");
    const writes = await Promise.allSettled([
      writeStorageBuffer("_uploads", stagingImageKey(id), normalized.processed, contentType(normalized.ext), session.storage_slug),
      writeStorageBuffer("_uploads", stagingThumbnailKey(id), normalized.thumbnail, "image/webp", session.storage_slug)
    ]);
    const writeFailure = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (writeFailure) throw writeFailure.reason;
    setImportPhase(id, "saving", "保存处理结果");
    const payload: PreparedPayload = {
      ...session.metadata_payload,
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
      detected_device: device,
      detected_brightness: brightness
    };
    const updated = await pool.query(
      `UPDATE upload_session
       SET status='ready', expected_size=COALESCE(expected_size, $2), metadata_payload=$3::jsonb,
           error='', updated_at=now()
       WHERE id=$1 AND status='preparing'
       RETURNING storage_slug`,
      [id, normalized.sourceSize, JSON.stringify(payload)]
    );
    // 只有状态仍是 preparing 才允许变为 ready；如果取消请求已经先一步改状态，这里必须把当前处理视作失败。
    if (!updated.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
    await notifyImportStatus(id);
    return preparedResult(id, session.storage_slug, payload);
  } catch (error) {
    await cleanupPreparedObjects(id, session.storage_slug);
    const failed = await pool.query(
      "UPDATE upload_session SET status='failed', error=$2, updated_at=now() WHERE id=$1 AND status IN ('receiving','preparing')",
      [id, errorMessage(error)]
    ).catch(() => undefined);
    if (failed && "rowCount" in failed && failed.rowCount) await notifyImportStatus(id).catch(() => undefined);
    throw error;
  } finally {
    await removeRawImport(rawKind(mode), id);
  }
}

export async function createStoredUploadSession(input: UploadCreateInput) {
  const limit = await getUploadLimitBytes();
  if (input.size > limit) throw new ApiError(400, "upload_too_large", "图片大小超过限制", { limit });
  const storageSlug = input.storage_slug ?? await getDefaultStorageSlug();
  await assertStorageUploadable(storageSlug);
  const id = input.session_id;
  if (await importWasCancelled(id)) throw new ApiError(409, "import_cancelled", "导入已取消");
  const expiresAt = new Date(Date.now() + appConfig.uploadTtlSeconds * 1000);
  const payload = {
    version: 2,
    import_mode: "upload",
    device: input.device,
    brightness: input.brightness,
    theme: input.theme,
    author: input.author,
    title: input.title,
    description: input.description,
    source: input.source,
    original: input.original,
    tags: input.tags
  };
  const result = await pool.query(
    `INSERT INTO upload_session(id, staging_object_key, expected_size, metadata_payload, idempotency_key, expires_at, storage_slug)
     VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key
     RETURNING *`,
    [id, stagingImageKey(id), input.size, JSON.stringify(payload), input.idempotency_key, expiresAt, storageSlug]
  );
  if (await importWasCancelled(id)) {
    await pool.query("DELETE FROM upload_session WHERE id=$1 AND status='created'", [id]);
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }
  return uploadSessionResponse(result.rows[0] as UploadSessionRecord);
}

export async function receiveStoredUpload(id: string, body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new ApiError(400, "empty_body", "Empty body");
  const claimed = await pool.query(
    "UPDATE upload_session SET status='receiving', updated_at=now() WHERE id=$1 AND status='created' AND metadata_payload->>'import_mode'='upload' RETURNING expected_size",
    [id]
  );
  if (!claimed.rowCount) throw new ApiError(409, "invalid_upload_state", "Invalid upload state");
  await notifyImportStatus(id);
  return runActive(id, async (signal) => {
    try {
      setImportPhase(id, "receiving", "服务端接收上传文件");
      await writeRawUpload(id, body, Number(claimed.rows[0].expected_size), signal);
      setImportPhase(id, "prepare-queued", "上传完成，准备进入图片处理");
      const prepared = await pool.query(
        "UPDATE upload_session SET status='preparing', updated_at=now() WHERE id=$1 AND status='receiving' RETURNING id",
        [id]
      );
      if (!prepared.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
      await notifyImportStatus(id);
      return prepareRawSession(id, "upload", signal);
    } catch (error) {
      await removeRawImport("upload", id);
      const failed = await pool.query(
        "UPDATE upload_session SET status='failed', error=$2, updated_at=now() WHERE id=$1 AND status IN ('receiving','preparing')",
        [id, errorMessage(error)]
      ).catch(() => undefined);
      if (failed && "rowCount" in failed && failed.rowCount) await notifyImportStatus(id).catch(() => undefined);
      throw error;
    }
  });
}

export async function createDownloadedImportSession(input: DownloadCreateInput) {
  await assertStorageUploadable(input.storage_slug);
  const id = input.session_id;
  if (await importWasCancelled(id)) throw new ApiError(409, "import_cancelled", "导入已取消");
  const expiresAt = new Date(Date.now() + appConfig.uploadTtlSeconds * 1000);
  const runtime = getRuntimeConfig();
  const payload = {
    version: 2,
    import_mode: "download",
    source_url: input.url,
    device: "pc",
    brightness: "auto",
    theme: "",
    author: "",
    title: "",
    description: "",
    source: "",
    original: runtime.link_image.fill_original_url ? input.url : "",
    tags: []
  };
  const result = await pool.query(
    `INSERT INTO upload_session(id, staging_object_key, expected_size, metadata_payload, idempotency_key, expires_at, storage_slug)
     VALUES($1,$2,NULL,$3::jsonb,$4,$5,$6)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key
     RETURNING *`,
    [id, stagingImageKey(id), JSON.stringify(payload), input.idempotency_key, expiresAt, input.storage_slug]
  );
  if (await importWasCancelled(id)) {
    await pool.query("DELETE FROM upload_session WHERE id=$1 AND status='created'", [id]);
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }
  const row = result.rows[0] as UploadSessionRecord;
  return { id: row.id, status: row.status, prepare_url: `/api/admin/import-links/download/${row.id}/prepare`, expires_at: new Date(row.expires_at).toISOString() };
}

export async function prepareDownloadedImport(id: string) {
  const claimed = await pool.query(
    `UPDATE upload_session SET status='receiving', updated_at=now()
     WHERE id=$1 AND status='created' AND metadata_payload->>'import_mode'='download'
     RETURNING metadata_payload`,
    [id]
  );
  if (!claimed.rowCount) throw new ApiError(409, "invalid_upload_state", "下载导入任务不能开始");
  await notifyImportStatus(id);
  const url = String(claimed.rows[0].metadata_payload.source_url ?? "");
  return runActive(id, async (signal) => {
    try {
      setImportPhase(id, "downloading", "服务端下载原图");
      await fetchImportImageToFile(url, rawImportPath("import", id), await getUploadLimitBytes(), signal);
      setImportPhase(id, "prepare-queued", "下载完成，准备进入图片处理");
      const prepared = await pool.query(
        "UPDATE upload_session SET status='preparing', updated_at=now() WHERE id=$1 AND status='receiving' RETURNING id",
        [id]
      );
      if (!prepared.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
      await notifyImportStatus(id);
      return prepareRawSession(id, "download", signal);
    } catch (error) {
      await removeRawImport("import", id);
      const failed = await pool.query(
        "UPDATE upload_session SET status='failed', error=$2, updated_at=now() WHERE id=$1 AND status IN ('receiving','preparing')",
        [id, errorMessage(error)]
      ).catch(() => undefined);
      if (failed && "rowCount" in failed && failed.rowCount) await notifyImportStatus(id).catch(() => undefined);
      throw error;
    }
  });
}

export async function previewPreparedImport(id: string) {
  const session = (await pool.query(
    "SELECT staging_object_key, storage_slug, status FROM upload_session WHERE id=$1",
    [id]
  )).rows[0];
  if (!session || !["ready", "committing"].includes(session.status)) throw new ApiError(404, "not_found", "准备好的图片不存在");
  const buffer = await readStorageBuffer("_uploads", session.staging_object_key, session.storage_slug);
  return new Response(buffer as unknown as BodyInit, {
    headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store" }
  });
}

export async function getPreparedImportStatus(id: string) {
  const row = (await pool.query(
    "SELECT status, error, metadata_payload FROM upload_session WHERE id=$1",
    [id]
  )).rows[0];
  if (!row) throw new ApiError(404, "not_found", "导入任务不存在");
  const status = row.status as string;
  const phase = status === "receiving" || status === "preparing" ? activeImportPhases.get(id) : undefined;
  const mode = row.metadata_payload?.import_mode as string | undefined;
  return {
    status,
    error: row.error as string,
    phase: phase?.phase ?? status,
    message: phase?.message ?? fallbackImportMessage(status, mode, row.error as string)
  };
}

async function getPreparedImportStatusEvent(id: string): Promise<StoredImportStatusEvent> {
  return { id, ...await getPreparedImportStatus(id) };
}

function missingImportStatus(id: string): StoredImportStatusEvent {
  return { id, status: "missing", error: "导入任务不存在", phase: "missing", message: "导入任务不存在" };
}

export async function listPreparedImportStatuses(ids: string[]): Promise<StoredImportStatusEvent[]> {
  const uniqueIds = [...new Set(ids)].slice(0, 100);
  return Promise.all(uniqueIds.map(async (id) => {
    try {
      return await getPreparedImportStatusEvent(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return missingImportStatus(id);
      throw error;
    }
  }));
}

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamPreparedImportEvents(ids: string[]): Response {
  const uniqueIds = [...new Set(ids)].slice(0, 100);
  const watched = new Set(uniqueIds);
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let listener: ((status: StoredImportStatusEvent) => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event, data)));
        } catch {
          closed = true;
        }
      };

      listener = (status) => {
        if (watched.has(status.id)) send("import-status", status);
      };
      importStatusEvents.on("status", listener);
      send("ready", { ids: uniqueIds });

      for (const id of uniqueIds) {
        getPreparedImportStatusEvent(id)
          .then((status) => send("import-status", status))
          .catch(() => send("import-status", missingImportStatus(id)));
      }

      heartbeat = setInterval(() => send("ping", { now: Date.now() }), 15_000);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (listener) importStatusEvents.off("status", listener);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

export async function commitPreparedImport(id: string, metadata: UploadMetadataOverride) {
  const lockClient = await pool.connect();
  const lockKey = `upload.commit:${id}`;
  // 提交既要搬对象又要写元数据；使用会话级 advisory lock 保证同一个导入 id 只能有一个提交者推进。
  const locked = Boolean((await lockClient.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey])).rows[0]?.locked);
  if (!locked) {
    lockClient.release();
    throw new ApiError(409, "upload_already_finalizing", "Import is already being committed");
  }
  try {
    let session = (await pool.query("SELECT * FROM upload_session WHERE id=$1", [id])).rows[0];
    if (!session) throw new ApiError(404, "not_found", "Upload session not found");
    if (session.status === "finalized") {
      const image = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
      if (!image) throw new ApiError(409, "finalized_image_missing", "Finalized image metadata is missing");
      await finishPreparedImport(image as ImageRecord, session.metadata_payload as PreparedPayload);
      return publicImage(image as ImageRecord);
    }
    if (!["ready", "committing"].includes(session.status)) throw new ApiError(409, "invalid_upload_state", "图片尚未准备完成");
    if (session.status === "ready") {
      const payload = { ...session.metadata_payload, ...metadata };
      const brightness = metadata.brightness === "auto" ? payload.detected_brightness : metadata.brightness;
      const finalKey = storageObjectKey(metadata.device, brightness, metadata.theme, id, payload.ext);
      const claimed = await pool.query(
        `UPDATE upload_session SET status='committing', metadata_payload=$2::jsonb,
         final_object_key=$3, updated_at=now() WHERE id=$1 AND status='ready' RETURNING *`,
        [id, JSON.stringify(payload), finalKey]
      );
      if (!claimed.rowCount) throw new ApiError(409, "upload_already_finalizing", "Import is already being committed");
      session = claimed.rows[0];
      await notifyImportStatus(id);
    }
    const payload = session.metadata_payload as PreparedPayload;
    const backend = session.storage_slug as string;
    const finalKey = session.final_object_key as string;
    const thumbKey = thumbnailObjectKey(finalKey);
    // 对象搬运按“目标不存在才搬”处理，使提交请求在网络中断后重试时可以从已完成的步骤继续。
    if (!(await exists("objects", finalKey, backend))) {
      if (!(await exists("_uploads", session.staging_object_key, backend))) throw new ApiError(409, "prepared_object_missing", "准备好的图片文件不存在");
      await moveObject("_uploads", session.staging_object_key, "objects", finalKey, contentType(payload.ext), backend);
    }
    if (!(await exists("thumbs", thumbKey, backend))) {
      if (!(await exists("_uploads", payload.prepared_thumbnail_key, backend))) throw new ApiError(409, "prepared_thumbnail_missing", "准备好的缩略图不存在");
      await moveObject("_uploads", payload.prepared_thumbnail_key, "thumbs", thumbKey, "image/webp", backend);
    }
    const brightness: Brightness = payload.brightness === "auto" ? payload.detected_brightness : payload.brightness;
    const cat = categoryKey(payload.device, brightness, payload.theme);
    const image = await withTransaction(async (client) => {
      // category.count 是连续序号来源，必须在事务里 FOR UPDATE 后再生成 index_key。
      await upsertCategory(client, cat, payload.device, brightness, payload.theme);
      await ensureTheme(client, payload.theme);
      await ensureAuthor(client, payload.author);
      const category = (await client.query("SELECT count FROM category WHERE category_key=$1 FOR UPDATE", [cat])).rows[0];
      const nextIndex = Number(category.count) + 1;
      const idx = indexKey(cat, nextIndex);
      const insertedRow = await client.query(
        `INSERT INTO metadata(id, device, brightness, theme, category_key, category_index, index_key,
         width, height, image_size, ext, object_key, storage_slug, title, description, source,
         original, md5, thumbnail_size, author)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [id, payload.device, brightness, payload.theme, cat, nextIndex, idx, payload.width,
          payload.height, payload.size, payload.ext, finalKey, backend, payload.title,
          payload.description, payload.source, payload.original, payload.md5,
          payload.thumbnail_size, payload.author || null]
      );
      const inserted = Boolean(insertedRow.rowCount);
      if (inserted) await adjustCategoryCount(client, cat, 1);
      await client.query("UPDATE upload_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='committing'", [id]);
      return (await client.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0];
    });
    await notifyImportStatus(id);
    await finishPreparedImport(image as ImageRecord, payload);
    return publicImage(image as ImageRecord);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
    lockClient.release();
  }
}

export async function cancelPreparedImport(id: string) {
  // 先标记取消再 abort/delete，避免上传或下载请求在取消间隙重新创建同一个 session。
  await markImportCancelled(id);
  emitCancelledImportStatus(id);
  const active = activeImports.get(id);
  active?.controller.abort();
  const session = (await pool.query(
    `DELETE FROM upload_session
     WHERE id=$1 AND status IN ('created','receiving','preparing','ready','failed','cancelled')
     RETURNING storage_slug, metadata_payload`,
    [id]
  )).rows[0];
  if (!session) {
    const existing = (await pool.query("SELECT status FROM upload_session WHERE id=$1", [id])).rows[0];
    if (existing?.status === "finalized") return;
    if (existing) throw new ApiError(409, "invalid_upload_state", "导入任务正在提交，无法取消");
    return;
  }
  await active?.promise.catch(() => undefined);
  const mode = session.metadata_payload?.import_mode as StoredImportMode;
  await Promise.all([
    cleanupPreparedObjects(id, session.storage_slug),
    removeRawImport(rawKind(mode), id)
  ]);
}
