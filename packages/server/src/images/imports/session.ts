import { appConfig } from "@imageshow/shared";
import { getInputImageMaxBytes } from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { pool, withTransaction } from "../../core/db.ts";
import { ApiError } from "../../core/api-error.ts";
import { privateNoStoreCacheControl } from "../../core/http/headers.ts";
import { assertStorageUploadable, getDefaultStorageSlug } from "../../storage/backend-registry.ts";
import { withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
import { readStorageBuffer } from "../../storage/object-access.ts";
import { contentType } from "../../storage/object-keys.ts";
import { createImageId, ImageTimeError, parseImageTime } from "../image-time.ts";
import { importSessionResponse, type ImportSessionRecord } from "../presenter.ts";
import { abortActiveImport } from "./execution.ts";
import {
  clearImportCancelled,
  importWasCancelled,
  markImportCancelled
} from "./lifecycle.ts";
import { emitCancelledImportStatus } from "./status.ts";
import { importRequestHash } from "./request-hash.ts";
import { withImportSessionLock } from "./session-lock.ts";
import {
  cleanupStagedObjects,
  preparedThumbnailResponse
} from "./staging.ts";
import { removeRawImport } from "./temp-files.ts";
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

async function createImportSessionUnderLocationLock(
  input: ImportCreateInput,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const storageSlug = input.storage_slug ?? await getDefaultStorageSlug();
  await assertStorageUploadable(storageSlug);
  signal.throwIfAborted();

  const runtime = getRuntimeConfig();
  const sourceUrl = input.source_url ?? "";
  const result = await withTransaction(async (client) => {
    signal.throwIfAborted();
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `import.create:${input.idempotency_key}`
    ]);
    const existing = (await client.query(
      `SELECT id, mode, request_hash, image_time
         FROM import_session
        WHERE idempotency_key=$1
        LIMIT 1`,
      [input.idempotency_key]
    )).rows[0] as Pick<
      ImportSessionRow,
      "id" | "mode" | "request_hash" | "image_time"
    > | undefined;
    signal.throwIfAborted();

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
      return { id: existing.id, mode: existing.mode };
    }

    const id = createImageId(normalizedImageTime.date, input.manifest_position);
    signal.throwIfAborted();
    const created = (await client.query(
      `INSERT INTO import_session(id, mode, storage_slug, source_url, expected_size, metadata_payload, idempotency_key, request_hash, image_time, expires_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       RETURNING id, mode`,
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
    )).rows[0] as ImportSessionRecord;
    signal.throwIfAborted();
    return created;
  });

  signal.throwIfAborted();
  if (await importWasCancelled(result.id)) {
    await pool.query("DELETE FROM import_session WHERE id=$1 AND status='created'", [result.id]);
    throw new ApiError(409, "import_cancelled", "导入已取消");
  }
  return importSessionResponse(result);
}

export function createImportSession(input: ImportCreateInput) {
  if (input.mode === "upload") {
    const limit = getInputImageMaxBytes();
    if (!input.size || input.size > limit) {
      throw new ApiError(400, "upload_too_large", "图片大小超过限制", { limit });
    }
  }
  return withStorageLocationReadLock((signal) =>
    createImportSessionUnderLocationLock(input, signal)
  );
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

  const buffer = await readStorageBuffer(
    "_uploads",
    payload.prepared_image_key,
    session.storage_slug
  );
  return new Response(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType(payload.ext),
      "Cache-Control": privateNoStoreCacheControl
    }
  });
}

export async function cancelImportSession(id: string) {
  await markImportCancelled(id);
  const activePromise = abortActiveImport(id);
  const cancelled = (await pool.query(
    `UPDATE import_session
     SET status='cancelled', execution_token=NULL, raw_token=NULL,
         expires_at=now(), updated_at=now()
     WHERE id=$1 AND status IN (
       'created','materializing','received','preparing','ready','failed','cancelled'
     )
     RETURNING id`,
    [id]
  )).rows[0] as { id: string } | undefined;

  if (cancelled) emitCancelledImportStatus(id);
  await activePromise?.catch(() => undefined);
  if (!cancelled) {
    const existing = (await pool.query(
      "SELECT status FROM import_session WHERE id=$1",
      [id]
    )).rows[0] as { status?: ImportStatus } | undefined;
    await clearImportCancelled(id);
    if (existing?.status === "finalized") return;
    if (existing) throw new ApiError(409, "invalid_import_state", "导入任务正在提交，无法取消");
    return;
  }
  return withImportSessionLock(id, async (signal) => {
    signal.throwIfAborted();
    const session = (await pool.query(
      "SELECT status, storage_slug FROM import_session WHERE id=$1",
      [id]
    )).rows[0] as Pick<ImportSessionRow, "status" | "storage_slug"> | undefined;
    if (!session) {
      await clearImportCancelled(id);
      return;
    }
    if (session.status !== "cancelled") {
      throw new ApiError(409, "invalid_import_state", "导入任务状态已变化");
    }
    try {
      signal.throwIfAborted();
      const cleanups = await Promise.allSettled([
        cleanupStagedObjects(id, session.storage_slug),
        removeRawImport(id)
      ]);
      const failures = cleanups
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) {
        throw new AggregateError(failures, "Cancelled import cleanup failed");
      }
      signal.throwIfAborted();
    } catch (error) {
      throw new ApiError(
        502,
        "import_cleanup_failed",
        "导入已取消，但暂存文件清理失败；后台任务将继续重试",
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
    await pool.query(
      "DELETE FROM import_session WHERE id=$1 AND status='cancelled'",
      [id]
    );
    await clearImportCancelled(id);
  });
}
