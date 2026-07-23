import type { Device } from "@imageshow/shared";
import { getInputImageMaxLongEdge } from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { writeStorageBuffer } from "../../storage/object-access.ts";
import { contentType } from "../../storage/object-keys.ts";
import { detectBrightness } from "../brightness.ts";
import { deviceFromDimensions } from "../classification.ts";
import {
  sha256Buffer,
  transcodeStoredImage
} from "../processing.ts";
import { getDuplicateImagesByMd5 } from "../read-models/duplicates.ts";
import {
  setImportPhase
} from "./status.ts";
import { assertImportStillPreparing } from "./lifecycle.ts";
import type {
  ImportMode,
  MetadataPayload,
  PreparedImportResult,
  PreparedPayload
} from "./types.ts";

function requiredDeviceFromDimensions(width: number, height: number): Device {
  return deviceFromDimensions(width, height) ?? "pc";
}

export async function preparedImportResult(
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

export async function prepareImportArtifacts(options: {
  id: string;
  mode: ImportMode;
  executionToken: string;
  sourcePath: string;
  sourceUrl: string;
  storageSlug: string;
  metadata: MetadataPayload;
  preparedImageKey: string;
  preparedThumbnailKey: string;
  signal: AbortSignal;
}) {
  const {
    id,
    mode,
    executionToken,
    sourcePath,
    sourceUrl,
    storageSlug,
    metadata,
    preparedImageKey,
    preparedThumbnailKey,
    signal
  } = options;
  signal.throwIfAborted();
  const runtime = getRuntimeConfig();
  setImportPhase(id, "normalizing", "校验格式、压缩原图并生成缩略图");
  const normalized = await transcodeStoredImage(sourcePath, {
    ...runtime.normalize,
    max_long_edge: Math.min(
      runtime.normalize.max_long_edge,
      getInputImageMaxLongEdge()
    )
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
      storageSlug
    ),
    writeStorageBuffer(
      "_uploads",
      preparedThumbnailKey,
      normalized.thumbnail,
      "image/webp",
      storageSlug
    )
  ]);
  const writeFailure = writes.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (writeFailure) throw writeFailure.reason;
  signal.throwIfAborted();
  await assertImportStillPreparing(id, executionToken);

  const payload: PreparedPayload = {
    ...metadata,
    mode,
    source_url: sourceUrl,
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
  return {
    payload,
    result: await preparedImportResult(id, storageSlug, payload)
  };
}
