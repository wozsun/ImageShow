import { appConfig } from "@imageshow/shared";
import { getInputImageMaxBytes } from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { pool, withTransaction } from "../../core/db.ts";
import { ApiError, privateNoStoreCacheControl } from "../../core/http.ts";
import { assertStorageUploadable, getDefaultStorageSlug } from "../../storage/backend-registry.ts";
import { contentType, readStorageBuffer } from "../../storage/storage.ts";
import { createImageId, ImageTimeError, parseImageTime } from "../image-time.ts";
import { importSessionResponse, type ImportSessionRecord } from "../presenter.ts";
import { proxyExternalImage } from "../serving.ts";
import { abortActiveImport } from "./execution.ts";
import {
  emitCancelledImportStatus,
  importWasCancelled,
  markImportCancelled,
  markImportFailed,
  notifyImportStatus,
  setImportPhase,
  withImportLease
} from "./progress.ts";
import { importRequestHash } from "./request-hash.ts";
import {
  cleanupStagedObjects,
  preparedThumbnailResponse,
  stagingImageKey
} from "./staging.ts";
import { removeRawImport, writeRawImport } from "./temp-files.ts";
import type {
  ImportCreateInput,
  ImportSessionRow,
  ImportStatus,
  MetadataPayload,
  PreparedPayload
} from "./types.ts";

function defaultMetadata(input: ImportCreateInput, imageTime: string): MetadataPayload {
  return {
    image_time: imageTime,
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

export async function createImportSession(input: ImportCreateInput) {
  const storageSlug = input.storage_slug ?? await getDefaultStorageSlug();
  await assertStorageUploadable(storageSlug);

  if (input.mode === "upload") {
    const limit = getInputImageMaxBytes();
    if (!input.size || input.size > limit) {
      throw new ApiError(400, "upload_too_large", "图片大小超过限制", { limit });
    }
  }

  const runtime = getRuntimeConfig();
  const sourceUrl = input.source_url ?? "";
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `import.create:${input.idempotency_key}`
    ]);
    const existing = (await client.query(
      "SELECT * FROM import_session WHERE idempotency_key=$1 LIMIT 1",
      [input.idempotency_key]
    )).rows[0] as ImportSessionRow | undefined;

    let normalizedImageTime;
    try {
      normalizedImageTime = parseImageTime(
        input.image_time ?? input.batch_time ?? (existing ? new Date(existing.image_time).toISOString() : undefined)
      );
    } catch (error) {
      if (error instanceof ImageTimeError) throw new ApiError(400, error.code, error.message);
      throw error;
    }

    const metadata = defaultMetadata({
      ...input,
      original: input.mode !== "upload" && runtime.link_image.fill_original_url
        ? sourceUrl
        : input.original
    }, normalizedImageTime.iso);
    const requestHash = importRequestHash({
      mode: input.mode,
      manifest_position: input.manifest_position ?? null,
      source_url: sourceUrl,
      size: input.size ?? null,
      storage_slug: storageSlug,
      metadata_payload: metadata
    });

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_conflict", "同一幂等键已用于不同导入请求");
      }
      return existing;
    }

    const id = createImageId(normalizedImageTime.date, input.manifest_position);
    return (await client.query(
      `INSERT INTO import_session(id, mode, storage_slug, source_url, expected_size, metadata_payload, idempotency_key, request_hash, image_time, expires_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        input.mode,
        storageSlug,
        sourceUrl,
        input.size ?? null,
        JSON.stringify(metadata),
        input.idempotency_key,
        requestHash,
        normalizedImageTime.date,
        new Date(Date.now() + appConfig.uploadTtlSeconds * 1000)
      ]
    )).rows[0] as ImportSessionRow;
  });

  if (await importWasCancelled(result.id)) {
    await pool.query("DELETE FROM import_session WHERE id=$1 AND status='created'", [result.id]);
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }
  return importSessionResponse(result as ImportSessionRecord);
}

export async function receiveImportFile(
  id: string,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
) {
  if (!body) throw new ApiError(400, "empty_body", "Empty body");
  const claimed = await pool.query(
    "UPDATE import_session SET status='receiving', updated_at=now() WHERE id=$1 AND mode='upload' AND status='created' RETURNING expected_size",
    [id]
  );
  if (!claimed.rowCount) {
    throw new ApiError(409, "invalid_import_state", "上传任务不能接收文件");
  }
  await notifyImportStatus(id);

  try {
    await withImportLease(id, async () => {
      setImportPhase(id, "receiving", "服务端接收上传文件");
      await writeRawImport(id, body, Number(claimed.rows[0].expected_size), signal);
    });
    return { id, status: "receiving" };
  } catch (error) {
    await removeRawImport(id);
    await markImportFailed(id, error);
    throw error;
  }
}

export async function previewImportSession(id: string, variant: "thumb" | "full" = "thumb") {
  const session = (await pool.query(
    "SELECT mode, source_url, storage_slug, status, prepared_payload FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as Pick<
    ImportSessionRow,
    "mode" | "source_url" | "storage_slug" | "status" | "prepared_payload"
  > | undefined;
  if (!session || !["ready", "committing"].includes(session.status)) {
    throw new ApiError(404, "not_found", "准备好的图片不存在");
  }

  const payload = session.prepared_payload as PreparedPayload;
  if (variant === "thumb") return preparedThumbnailResponse(payload, session.storage_slug);
  if (session.mode === "proxy") {
    return proxyExternalImage(
      session.source_url,
      payload.ext || "jpg",
      false,
      { "Cache-Control": privateNoStoreCacheControl },
      undefined,
      () => preparedThumbnailResponse(payload, session.storage_slug)
    );
  }

  const buffer = await readStorageBuffer("_uploads", stagingImageKey(id), session.storage_slug);
  return new Response(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType(payload.ext),
      "Cache-Control": privateNoStoreCacheControl
    }
  });
}

export async function cancelImportSession(id: string) {
  await markImportCancelled(id);
  emitCancelledImportStatus(id);
  const activePromise = abortActiveImport(id);
  const session = (await pool.query(
    `DELETE FROM import_session
     WHERE id=$1 AND status IN ('created','receiving','preparing','ready','failed','cancelled')
     RETURNING storage_slug, prepared_payload`,
    [id]
  )).rows[0] as Pick<ImportSessionRow, "storage_slug" | "prepared_payload"> | undefined;

  if (!session) {
    const existing = (await pool.query(
      "SELECT status FROM import_session WHERE id=$1",
      [id]
    )).rows[0] as { status?: ImportStatus } | undefined;
    if (existing?.status === "finalized") return;
    if (existing) throw new ApiError(409, "invalid_import_state", "导入任务正在提交，无法取消");
    return;
  }

  await activePromise?.catch(() => undefined);
  await Promise.all([
    cleanupStagedObjects(id, session.storage_slug),
    removeRawImport(id)
  ]);
}
