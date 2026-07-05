import type { z } from "zod";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { appConfig, type Brightness, type Device, type ImageExt } from "@imageshow/shared";
import { pool, withTransaction } from "../../core/db.js";
import { ApiError, errorMessage, privateNoStoreCacheControl } from "../../core/http.js";
import { redis } from "../../core/redis-client.js";
import { invalidateImageReadCaches, invalidateMd5Cache, setImageLookup } from "../image-cache.js";
import { syncRandomImage } from "../../random/random-cache.js";
import { getRuntimeConfig } from "../../config/env.js";
import { assertStorageUploadable, getDefaultStorageSlug, getImageMaxLongEdge, getUploadLimitBytes } from "../../config/settings.js";
import { importCommitInput, importCreateInput } from "../../core/validation.js";
import { contentType, copyObject, exists, readStorageBuffer, removeObject, writeStorageBuffer } from "../../storage/storage.js";
import { linkThumbnailKey, storageObjectKey, thumbnailObjectKey } from "../../storage/image-paths.js";
import { ensureAuthor } from "../../authors/service.js";
import { ensureTheme } from "../../themes/service.js";
import { setImageTags } from "../../tags/service.js";
import { detectBrightness } from "../brightness.js";
import { createThumbnail, probeImageBytes, transcodeStoredImage } from "../processing.js";
import { deviceFromDimensions, resolveBrightnessWith, resolveClassification, resolveDeviceWith } from "../classification.js";
import { publicImage, importSessionResponse, type ImageRecord, type ImportSessionRecord } from "../presenter.js";
import { checkImageMd5 } from "../query.js";
import { proxyExternalImage } from "../serving.js";
import { fetchImportImage, fetchImportImageToFile } from "./fetch.js";
import { rawImportPath, removeRawImport, writeRawImport } from "./temp-files.js";

type ImportCreateInput = z.infer<typeof importCreateInput>;
type ImportCommitInput = z.infer<typeof importCommitInput>;
type ImportMode = "upload" | "download" | "proxy";
type ImportStatus = "created" | "receiving" | "preparing" | "ready" | "committing" | "finalized" | "failed" | "cancelled";

export type ImportMetadata = ImportCommitInput;

type MetadataPayload = ImportMetadata & {
  version: 3;
};

type PreparedPayload = MetadataPayload & {
  version: 3;
  mode: ImportMode;
  source_url: string;
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
  resolved_device: Device;
  resolved_brightness: Brightness;
};

type ImportSessionRow = {
  id: string;
  mode: ImportMode;
  status: ImportStatus;
  storage_slug: string;
  source_url: string;
  expected_size: string | number | null;
  final_object_key: string;
  metadata_payload: MetadataPayload;
  prepared_payload: Partial<PreparedPayload>;
  request_hash: string;
  error: string;
  expires_at: string | Date;
};

export type PreparedImportResult = {
  id: string;
  mode: ImportMode;
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
  duplicate_exists: boolean;
  duplicates: Awaited<ReturnType<typeof checkImageMd5>>["items"];
};

type ImportStatusEvent = {
  id: string;
  status: string;
  error: string;
  phase: string;
  message: string;
};

const activeImports = new Map<string, { controller: AbortController; promise: Promise<PreparedImportResult> }>();
const activeImportPhases = new Map<string, { phase: string; message: string }>();
const importStatusEvents = new EventEmitter();
const cancelledImportKey = (id: string) => `imageshow:import-cancelled:${id}`;
const cancelledImports = new Map<string, number>();

class ImportPrepareLimiter {
  private active = 0;
  private queue: Array<{ run: () => void; signal: AbortSignal; abort: () => void }> = [];

  constructor(private readonly limit: () => number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>, hooks: { onQueued?: () => void; onStarted?: () => void } = {}): Promise<T> {
    await this.acquire(signal, hooks.onQueued);
    hooks.onStarted?.();
    try {
      return await work();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.drain();
    }
  }

  private acquire(signal: AbortSignal, onQueued?: () => void) {
    if (signal.aborted) throw new ApiError(409, "import_cancelled", "导入已取消");
    if (this.active < this.currentLimit()) {
      this.active += 1;
      return Promise.resolve();
    }
    onQueued?.();
    return new Promise<void>((resolve, reject) => {
      let entry: { run: () => void; signal: AbortSignal; abort: () => void };
      entry = {
        signal,
        abort: () => {
          this.queue = this.queue.filter((item) => item !== entry);
          reject(new ApiError(409, "import_cancelled", "导入已取消"));
        },
        run: () => {
          signal.removeEventListener("abort", entry.abort);
          this.active += 1;
          resolve();
        }
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  private currentLimit() {
    return Math.max(1, Math.floor(this.limit()));
  }

  private drain() {
    while (this.active < this.currentLimit()) {
      const next = this.queue.shift();
      if (!next) return;
      if (next.signal.aborted) {
        next.abort();
        continue;
      }
      next.run();
    }
  }
}

const uploadPrepareLimiter = new ImportPrepareLimiter(() => getRuntimeConfig().upload.global_concurrency);
const linkPrepareLimiter = new ImportPrepareLimiter(() => getRuntimeConfig().link_image.global_concurrency);

importStatusEvents.setMaxListeners(0);

function stagingImageKey(id: string) {
  return `${id}.image.webp`;
}

function stagingThumbnailKey(id: string) {
  return `${id}.thumb.webp`;
}

function defaultMetadata(input: ImportCreateInput): MetadataPayload {
  return {
    version: 3,
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
}

function requiredDeviceFromDimensions(width: number, height: number): Device {
  return deviceFromDimensions(width, height) ?? "pc";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function importRequestHash(input: ImportCreateInput, storageSlug: string, sourceUrl: string, metadata: MetadataPayload) {
  return createHash("sha256").update(stableJson({
    mode: input.mode,
    source_url: sourceUrl,
    size: input.size ?? null,
    storage_slug: storageSlug,
    metadata_payload: { ...metadata, tags: [...metadata.tags].sort() }
  })).digest("hex");
}

async function preparedResult(id: string, mode: ImportMode, storageSlug: string, payload: PreparedPayload): Promise<PreparedImportResult> {
  const duplicate = await checkImageMd5(payload.md5);
  return {
    id,
    mode,
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
    device: payload.resolved_device,
    brightness: payload.resolved_brightness,
    storage_slug: storageSlug,
    duplicate_exists: duplicate.exists,
    duplicates: duplicate.items
  };
}

function importMessage(status: string, mode?: string, error?: string) {
  if (status === "created") return mode === "upload" ? "等待接收原图" : "等待开始处理";
  if (status === "receiving") return mode === "download" ? "服务端下载原图" : "服务端接收上传文件";
  if (status === "preparing") return mode === "proxy" ? "探测外链并生成缩略图" : "标准化图片并生成缩略图";
  if (status === "ready") return "服务端处理完成";
  if (status === "committing") return "写入图库";
  if (status === "finalized") return "已写入图库";
  if (status === "failed") return error || "处理失败";
  if (status === "cancelled") return "已取消";
  return "等待处理";
}

function emitImportStatus(status: ImportStatusEvent) {
  importStatusEvents.emit("status", status);
}

function emitCancelledImportStatus(id: string) {
  emitImportStatus({ id, status: "cancelled", error: "", phase: "cancelled", message: "已取消" });
}

async function notifyImportStatus(id: string) {
  emitImportStatus(await getImportStatusEvent(id));
}

function setImportPhase(id: string, phase: string, message: string) {
  activeImportPhases.set(id, { phase, message });
  notifyImportStatus(id).catch(() => undefined);
}

function clearImportPhase(id: string) {
  activeImportPhases.delete(id);
}

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

async function runActive(id: string, work: (signal: AbortSignal) => Promise<PreparedImportResult>) {
  const active = activeImports.get(id);
  if (active) return active.promise;
  const controller = new AbortController();
  const promise = Promise.resolve().then(() => work(controller.signal));
  activeImports.set(id, { controller, promise });
  try {
    return await promise;
  } finally {
    if (activeImports.get(id)?.promise === promise) activeImports.delete(id);
    activeImportPhases.delete(id);
  }
}

async function sessionStillPreparing(id: string) {
  const row = (await pool.query("SELECT status FROM import_session WHERE id=$1", [id])).rows[0] as { status?: ImportStatus } | undefined;
  if (!row || row.status === "cancelled") throw new ApiError(409, "import_cancelled", "导入已取消");
  if (row.status !== "preparing") throw new ApiError(409, "invalid_import_state", "导入任务状态已变化");
}

async function cleanupStagedObjects(id: string, storageSlug: string) {
  await Promise.all([
    removeObject("_uploads", stagingImageKey(id), storageSlug).catch(() => undefined),
    removeObject("_uploads", stagingThumbnailKey(id), storageSlug).catch(() => undefined)
  ]);
}

async function finishImport(image: ImageRecord, payload: PreparedPayload, inserted: boolean) {
  const tagsChanged = Boolean(payload.tags?.length);
  if (tagsChanged) await setImageTags(image.id, payload.tags, { syncRandom: false, invalidate: false });
  if (inserted || tagsChanged) await syncRandomImage(image.id);
  await invalidateMd5Cache(payload.md5);
  await invalidateImageReadCaches();
  if (!image.is_link) {
    await setImageLookup({
      object_key: image.object_key,
      thumb_key: thumbnailObjectKey(image.object_key),
      ext: image.ext,
      slug: image.storage_slug
    });
  }
}

async function updateFailed(id: string, error: unknown) {
  const failed = await pool.query(
    "UPDATE import_session SET status='failed', error=$2, updated_at=now() WHERE id=$1 AND status IN ('receiving','preparing')",
    [id, errorMessage(error)]
  ).catch(() => undefined);
  if (failed && "rowCount" in failed && failed.rowCount) await notifyImportStatus(id).catch(() => undefined);
}

async function prepareStoredImageSession(id: string, mode: Extract<ImportMode, "upload" | "download">, signal: AbortSignal): Promise<PreparedImportResult> {
  const session = (await pool.query("SELECT * FROM import_session WHERE id=$1", [id])).rows[0] as ImportSessionRow | undefined;
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
      max_long_edge: Math.min(runtime.normalize.max_long_edge, await getImageMaxLongEdge())
    });
    if (signal.aborted) throw new ApiError(409, "import_cancelled", "导入已取消");
    await sessionStillPreparing(id);

    setImportPhase(id, "detecting", "确认图片尺寸、设备类型和明暗");
    const device = resolveDeviceWith(session.metadata_payload.device, () => requiredDeviceFromDimensions(normalized.width, normalized.height));
    const brightness = await resolveBrightnessWith(session.metadata_payload.brightness, () => detectBrightness(normalized.thumbnail));

    setImportPhase(id, "staging", "写入处理后的图片和缩略图");
    const writes = await Promise.allSettled([
      writeStorageBuffer("_uploads", stagingImageKey(id), normalized.processed, contentType(normalized.ext), session.storage_slug),
      writeStorageBuffer("_uploads", stagingThumbnailKey(id), normalized.thumbnail, "image/webp", session.storage_slug)
    ]);
    const writeFailure = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (writeFailure) throw writeFailure.reason;

    const payload: PreparedPayload = {
      ...session.metadata_payload,
      version: 3,
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
      resolved_device: device,
      resolved_brightness: brightness
    };
    const updated = await pool.query(
      `UPDATE import_session
       SET status='ready', prepared_payload=$2::jsonb, error='', updated_at=now()
       WHERE id=$1 AND status='preparing'
       RETURNING storage_slug`,
      [id, JSON.stringify(payload)]
    );
    if (!updated.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
    await notifyImportStatus(id);
    return preparedResult(id, mode, session.storage_slug, payload);
  } catch (error) {
    await cleanupStagedObjects(id, session.storage_slug);
    await updateFailed(id, error);
    throw error;
  } finally {
    await removeRawImport(id);
  }
}

async function prepareUploadSession(id: string, signal: AbortSignal) {
  const prepared = await pool.query(
    "UPDATE import_session SET status='preparing', updated_at=now() WHERE id=$1 AND mode='upload' AND status='receiving' RETURNING id",
    [id]
  );
  if (!prepared.rowCount) throw new ApiError(409, "invalid_import_state", "上传任务尚未接收文件");
  await notifyImportStatus(id);
  return prepareStoredImageSession(id, "upload", signal);
}

async function prepareDownloadSession(id: string, signal: AbortSignal) {
  const claimed = await pool.query(
    "UPDATE import_session SET status='receiving', updated_at=now() WHERE id=$1 AND mode='download' AND status='created' RETURNING source_url",
    [id]
  );
  if (!claimed.rowCount) throw new ApiError(409, "invalid_import_state", "下载导入任务不能开始");
  await notifyImportStatus(id);
  const url = String(claimed.rows[0].source_url ?? "");
  try {
    setImportPhase(id, "downloading", "服务端下载原图");
    await fetchImportImageToFile(url, rawImportPath(id), await getUploadLimitBytes(), signal);
    setImportPhase(id, "prepare-queued", "下载完成，准备进入图片处理");
    const prepared = await pool.query(
      "UPDATE import_session SET status='preparing', updated_at=now() WHERE id=$1 AND status='receiving' RETURNING id",
      [id]
    );
    if (!prepared.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
    await notifyImportStatus(id);
    return prepareStoredImageSession(id, "download", signal);
  } catch (error) {
    await removeRawImport(id);
    await updateFailed(id, error);
    throw error;
  }
}

async function prepareProxySession(id: string, signal: AbortSignal) {
  const claimed = await pool.query(
    "UPDATE import_session SET status='preparing', updated_at=now() WHERE id=$1 AND mode='proxy' AND status='created' RETURNING *",
    [id]
  );
  if (!claimed.rowCount) throw new ApiError(409, "invalid_import_state", "代理链接导入任务不能开始");
  await notifyImportStatus(id);
  const session = claimed.rows[0] as ImportSessionRow;
  try {
    setImportPhase(id, "probing", "下载外链用于探测尺寸和生成缩略图");
    const buffer = await fetchImportImage(session.source_url, await getUploadLimitBytes(), signal);
    const probe = await probeImageBytes(buffer);
    const thumbnail = await createThumbnail(buffer);
    const device = resolveDeviceWith(session.metadata_payload.device, () => requiredDeviceFromDimensions(probe.width, probe.height));
    const brightness = await resolveBrightnessWith(session.metadata_payload.brightness, () => detectBrightness(thumbnail));
    await writeStorageBuffer("_uploads", stagingThumbnailKey(id), thumbnail, "image/webp", session.storage_slug);
    const payload: PreparedPayload = {
      ...session.metadata_payload,
      version: 3,
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
      resolved_device: device,
      resolved_brightness: brightness
    };
    const updated = await pool.query(
      `UPDATE import_session
       SET status='ready', prepared_payload=$2::jsonb, error='', updated_at=now()
       WHERE id=$1 AND status='preparing'
       RETURNING storage_slug`,
      [id, JSON.stringify(payload)]
    );
    if (!updated.rowCount) throw new ApiError(409, "import_cancelled", "导入已取消");
    await notifyImportStatus(id);
    return preparedResult(id, "proxy", session.storage_slug, payload);
  } catch (error) {
    await cleanupStagedObjects(id, session.storage_slug);
    await updateFailed(id, error);
    throw error;
  }
}

export async function createImportSession(input: ImportCreateInput) {
  const storageSlug = input.storage_slug ?? await getDefaultStorageSlug();
  await assertStorageUploadable(storageSlug);
  const id = input.session_id;
  if (await importWasCancelled(id)) throw new ApiError(409, "import_cancelled", "导入已取消");

  if (input.mode === "upload") {
    const limit = await getUploadLimitBytes();
    if (!input.size || input.size > limit) throw new ApiError(400, "upload_too_large", "图片大小超过限制", { limit });
  }

  const runtime = getRuntimeConfig();
  const sourceUrl = input.source_url ?? "";
  const metadata = defaultMetadata({
    ...input,
    original: input.mode !== "upload" && runtime.link_image.fill_original_url ? sourceUrl : input.original
  });
  const requestHash = importRequestHash(input, storageSlug, sourceUrl, metadata);
  const result = await pool.query(
    `INSERT INTO import_session(id, mode, storage_slug, source_url, expected_size, metadata_payload, idempotency_key, request_hash, expires_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=import_session.idempotency_key
     WHERE import_session.request_hash=excluded.request_hash
     RETURNING *`,
    [id, input.mode, storageSlug, sourceUrl, input.size ?? null, JSON.stringify(metadata), input.idempotency_key, requestHash, new Date(Date.now() + appConfig.uploadTtlSeconds * 1000)]
  );
  if (!result.rowCount) throw new ApiError(409, "idempotency_conflict", "同一幂等键已用于不同导入请求");
  if (await importWasCancelled(id)) {
    await pool.query("DELETE FROM import_session WHERE id=$1 AND status='created'", [id]);
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }
  return importSessionResponse(result.rows[0] as ImportSessionRecord);
}

export async function receiveImportFile(id: string, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal) {
  if (!body) throw new ApiError(400, "empty_body", "Empty body");
  const claimed = await pool.query(
    "UPDATE import_session SET status='receiving', updated_at=now() WHERE id=$1 AND mode='upload' AND status='created' RETURNING expected_size",
    [id]
  );
  if (!claimed.rowCount) throw new ApiError(409, "invalid_import_state", "上传任务不能接收文件");
  await notifyImportStatus(id);
  try {
    setImportPhase(id, "receiving", "服务端接收上传文件");
    await writeRawImport(id, body, Number(claimed.rows[0].expected_size), signal);
    return { id, status: "receiving" };
  } catch (error) {
    await removeRawImport(id);
    await updateFailed(id, error);
    throw error;
  }
}

export async function prepareImportSession(id: string) {
  const session = (await pool.query("SELECT * FROM import_session WHERE id=$1", [id])).rows[0] as ImportSessionRow | undefined;
  if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
  if (session.status === "ready") return preparedResult(id, session.mode, session.storage_slug, session.prepared_payload as PreparedPayload);
  if (session.status === "finalized") throw new ApiError(409, "import_finalized", "导入任务已完成");
  if (await importWasCancelled(id)) throw new ApiError(409, "import_cancelled", "导入已取消");
  const waitHooks = {
    onQueued: () => setImportPhase(id, "prepare-waiting", "服务端全局处理名额已满，等待空闲名额"),
    onStarted: () => clearImportPhase(id)
  };
  return runActive(id, (signal) => {
    if (session.mode === "upload") return uploadPrepareLimiter.run(signal, () => prepareUploadSession(id, signal), waitHooks);
    if (session.mode === "download") return linkPrepareLimiter.run(signal, () => prepareDownloadSession(id, signal), waitHooks);
    return linkPrepareLimiter.run(signal, () => prepareProxySession(id, signal), waitHooks);
  });
}

export async function previewImportSession(id: string) {
  const session = (await pool.query(
    "SELECT mode, source_url, storage_slug, status, prepared_payload FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as Pick<ImportSessionRow, "mode" | "source_url" | "storage_slug" | "status" | "prepared_payload"> | undefined;
  if (!session || !["ready", "committing"].includes(session.status)) throw new ApiError(404, "not_found", "准备好的图片不存在");
  const payload = session.prepared_payload as PreparedPayload;
  if (session.mode === "proxy") {
    return proxyExternalImage(session.source_url, payload.ext || "jpg", false, { "Cache-Control": privateNoStoreCacheControl }, undefined, async () => {
      const buffer = await readStorageBuffer("_uploads", payload.prepared_thumbnail_key, session.storage_slug);
      return new Response(buffer as unknown as BodyInit, {
        headers: { "Content-Type": "image/webp", "Cache-Control": privateNoStoreCacheControl }
      });
    });
  }
  const buffer = await readStorageBuffer("_uploads", stagingImageKey(id), session.storage_slug);
  return new Response(buffer as unknown as BodyInit, {
    headers: { "Content-Type": contentType(payload.ext), "Cache-Control": privateNoStoreCacheControl }
  });
}

export async function getImportStatus(id: string) {
  const row = (await pool.query(
    "SELECT mode, status, error FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as Pick<ImportSessionRow, "mode" | "status" | "error"> | undefined;
  if (!row) throw new ApiError(404, "not_found", "导入任务不存在");
  const phase = ["created", "receiving", "preparing"].includes(row.status) ? activeImportPhases.get(id) : undefined;
  return {
    status: row.status,
    error: row.error,
    phase: phase?.phase ?? row.status,
    message: phase?.message ?? importMessage(row.status, row.mode, row.error)
  };
}

async function getImportStatusEvent(id: string): Promise<ImportStatusEvent> {
  return { id, ...await getImportStatus(id) };
}

function missingImportStatus(id: string): ImportStatusEvent {
  return { id, status: "missing", error: "导入任务不存在", phase: "missing", message: "导入任务不存在" };
}

export async function listImportStatuses(ids: string[]): Promise<ImportStatusEvent[]> {
  const uniqueIds = [...new Set(ids)].slice(0, 100);
  return Promise.all(uniqueIds.map(async (id) => {
    try {
      return await getImportStatusEvent(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return missingImportStatus(id);
      throw error;
    }
  }));
}

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamImportEvents(ids: string[]): Response {
  const uniqueIds = [...new Set(ids)].slice(0, 100);
  const watched = new Set(uniqueIds);
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let listener: ((status: ImportStatusEvent) => void) | undefined;

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
        getImportStatusEvent(id)
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

async function commitStoredImageSession(id: string, session: ImportSessionRow, payload: PreparedPayload) {
  const backend = session.storage_slug;
  const finalKey = session.final_object_key;
  const thumbKey = thumbnailObjectKey(finalKey);
  let copiedImage = false;
  let copiedThumb = false;
  let dbCommitted = false;
  try {
    if (!(await exists("media", finalKey, backend))) {
      if (!(await exists("_uploads", stagingImageKey(id), backend))) throw new ApiError(409, "prepared_object_missing", "准备好的图片文件不存在");
      await copyObject("_uploads", stagingImageKey(id), "media", finalKey, backend);
      copiedImage = true;
    }
    if (!(await exists("thumbs", thumbKey, backend))) {
      if (!(await exists("_uploads", payload.prepared_thumbnail_key, backend))) throw new ApiError(409, "prepared_thumbnail_missing", "准备好的缩略图不存在");
      await copyObject("_uploads", payload.prepared_thumbnail_key, "thumbs", thumbKey, backend);
      copiedThumb = true;
    }

    const classification = resolveClassification(payload, { device: payload.resolved_device, brightness: payload.resolved_brightness });
    const result = await withTransaction(async (client) => {
      await ensureTheme(client, payload.theme);
      await ensureAuthor(client, payload.author);
      const insertedRow = await client.query(
        `INSERT INTO metadata(id, device, brightness, theme, width, height, image_size, ext,
         object_key, storage_slug, title, description, source, original, md5, thumbnail_size, author)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [id, classification.device, classification.brightness, payload.theme, payload.width, payload.height,
          payload.size, payload.ext, finalKey, backend, payload.title,
          payload.description, payload.source, payload.original, payload.md5,
          payload.thumbnail_size, payload.author || null]
      );
      const inserted = Boolean(insertedRow.rowCount);
      await client.query("UPDATE import_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='committing'", [id]);
      return { image: (await client.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord, inserted };
    });
    dbCommitted = true;
    await Promise.all([
      removeObject("_uploads", stagingImageKey(id), backend).catch(() => undefined),
      removeObject("_uploads", payload.prepared_thumbnail_key, backend).catch(() => undefined)
    ]);
    await finishImport(result.image, payload, result.inserted);
    return { status: "imported" as const, item: await publicImage(result.image) };
  } catch (error) {
    if (!dbCommitted) {
      await Promise.all([
        copiedImage ? removeObject("media", finalKey, backend).catch(() => undefined) : Promise.resolve(),
        copiedThumb ? removeObject("thumbs", thumbKey, backend).catch(() => undefined) : Promise.resolve()
      ]);
    }
    throw error;
  }
}

async function commitProxySession(id: string, session: ImportSessionRow, payload: PreparedPayload) {
  const backend = session.storage_slug;
  const classification = resolveClassification(payload, { device: payload.resolved_device, brightness: payload.resolved_brightness });
  const linkKey = linkThumbnailKey(classification.device, classification.brightness, payload.theme, id);
  let copiedLink = false;
  let dbCommitted = false;
  try {
    if (!(await exists("link", linkKey, backend))) {
      if (!(await exists("_uploads", payload.prepared_thumbnail_key, backend))) throw new ApiError(409, "prepared_thumbnail_missing", "准备好的缩略图不存在");
      await copyObject("_uploads", payload.prepared_thumbnail_key, "link", linkKey, backend);
      copiedLink = true;
    }

    const result = await withTransaction(async (client) => {
      await ensureTheme(client, payload.theme);
      await ensureAuthor(client, payload.author);
      const insertedRow = await client.query(
        `INSERT INTO metadata(id, device, brightness, theme, width, height, ext,
         object_key, storage_slug, is_link, title, description, source, original, md5, thumbnail_size, author)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (object_key) DO NOTHING RETURNING *`,
        [id, classification.device, classification.brightness, payload.theme, payload.width, payload.height,
          payload.ext, payload.source_url, backend, payload.title,
          payload.description, payload.source, payload.original, payload.md5,
          payload.thumbnail_size, payload.author || null]
      );
      const inserted = Boolean(insertedRow.rowCount);
      await client.query("UPDATE import_session SET status='finalized', updated_at=now() WHERE id=$1 AND status='committing'", [id]);
      const image = inserted
        ? insertedRow.rows[0] as ImageRecord
        : (await client.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord | undefined;
      return { image, inserted };
    });
    dbCommitted = true;

    await removeObject("_uploads", payload.prepared_thumbnail_key, backend).catch(() => undefined);
    if (!result.image) {
      await removeObject("link", linkKey, backend).catch(() => undefined);
      return { status: "duplicate" as const };
    }
    await finishImport(result.image, payload, result.inserted);
    return { status: "imported" as const, item: await publicImage(result.image) };
  } catch (error) {
    if (!dbCommitted && copiedLink) await removeObject("link", linkKey, backend).catch(() => undefined);
    throw error;
  }
}

export async function commitImportSession(id: string, metadata: ImportMetadata) {
  const lockClient = await pool.connect();
  const lockKey = `import.commit:${id}`;
  const locked = Boolean((await lockClient.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey])).rows[0]?.locked);
  if (!locked) {
    lockClient.release();
    throw new ApiError(409, "import_already_finalizing", "Import is already being committed");
  }
  try {
    let session = (await pool.query("SELECT * FROM import_session WHERE id=$1", [id])).rows[0] as ImportSessionRow | undefined;
    if (!session) throw new ApiError(404, "not_found", "导入任务不存在");
    if (session.status === "finalized") {
      const image = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord | undefined;
      return image ? { status: "imported" as const, item: await publicImage(image) } : { status: "duplicate" as const };
    }
    if (!["ready", "committing"].includes(session.status)) throw new ApiError(409, "invalid_import_state", "图片尚未准备完成");
    if (session.status === "ready") {
      const payload = { ...session.prepared_payload, ...metadata } as PreparedPayload;
      const classification = resolveClassification(metadata, { device: payload.resolved_device, brightness: payload.resolved_brightness });
      const finalKey = session.mode === "proxy" ? "" : storageObjectKey(classification.device, classification.brightness, metadata.theme, id, payload.ext);
      const claimed = await pool.query(
        `UPDATE import_session
         SET status='committing', metadata_payload=$2::jsonb, prepared_payload=$3::jsonb,
             final_object_key=$4, updated_at=now()
         WHERE id=$1 AND status='ready'
         RETURNING *`,
        [id, JSON.stringify(metadata), JSON.stringify(payload), finalKey]
      );
      if (!claimed.rowCount) throw new ApiError(409, "import_already_finalizing", "Import is already being committed");
      session = claimed.rows[0] as ImportSessionRow;
      await notifyImportStatus(id);
    }
    const payload = session.prepared_payload as PreparedPayload;
    const result = session.mode === "proxy"
      ? await commitProxySession(id, session, payload)
      : await commitStoredImageSession(id, session, payload);
    await notifyImportStatus(id);
    return result;
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
    lockClient.release();
  }
}

export async function cancelImportSession(id: string) {
  await markImportCancelled(id);
  emitCancelledImportStatus(id);
  const active = activeImports.get(id);
  active?.controller.abort();
  const session = (await pool.query(
    `DELETE FROM import_session
     WHERE id=$1 AND status IN ('created','receiving','preparing','ready','failed','cancelled')
     RETURNING storage_slug, prepared_payload`,
    [id]
  )).rows[0] as Pick<ImportSessionRow, "storage_slug" | "prepared_payload"> | undefined;
  if (!session) {
    const existing = (await pool.query("SELECT status FROM import_session WHERE id=$1", [id])).rows[0] as { status?: ImportStatus } | undefined;
    if (existing?.status === "finalized") return;
    if (existing) throw new ApiError(409, "invalid_import_state", "导入任务正在提交，无法取消");
    return;
  }
  await active?.promise.catch(() => undefined);
  await Promise.all([
    cleanupStagedObjects(id, session.storage_slug),
    removeRawImport(id)
  ]);
}
