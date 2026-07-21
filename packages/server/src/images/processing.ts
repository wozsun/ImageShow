import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import sharp from "sharp";
import { type ImageExt } from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import { getInputImageMaxLongEdge, getThumbnailSettings } from "../config/app-settings.ts";
import { getStorageBackend } from "../storage/backend-registry.ts";

export function configureSharpConcurrency() {
  sharp.concurrency(Math.max(1, getRuntimeConfig().upload.concurrency));
}
import {
  readStorageBuffer,
  safeStoragePath,
  writeStorageBuffer
} from "../storage/storage.ts";

type ImageInput = Buffer | string;

function normalizeImageExt(ext?: string): ImageExt | undefined {
  const value = ext === "jpeg" ? "jpg" : ext;
  return value && ["jpg", "png", "webp", "gif", "avif"].includes(value) ? value as ImageExt : undefined;
}

async function detectImageExt(input: ImageInput) {
  const detected = typeof input === "string" ? await fileTypeFromFile(input) : await fileTypeFromBuffer(input);
  return normalizeImageExt(detected?.ext);
}

export function md5Buffer(input: Buffer) {
  return createHash("md5").update(input).digest("hex");
}

async function imageDimensions(input: ImageInput) {
  const meta = await sharp(input).metadata();
  // sharp 的 metadata 宽高是原始像素方向；带 EXIF 旋转的手机图在展示时会互换宽高，因此这里返回展示方向。
  // longEdge 仍按原始像素最大边校验，因为转码前解码压力取决于真实像素尺寸。
  const rotated = typeof meta.orientation === "number" && meta.orientation >= 5 && meta.orientation <= 8;
  const width = rotated ? meta.height ?? 0 : meta.width ?? 0;
  const height = rotated ? meta.width ?? 0 : meta.height ?? 0;
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const limit = await getInputImageMaxLongEdge();
  if (!longEdge || longEdge > limit) {
    throw new ApiError(400, "image_too_large", "图片尺寸超过限制", { limit });
  }
  return { width, height };
}

export async function probeImageBytes(input: Buffer) {
  const ext = await detectImageExt(input);
  if (!ext) throw new ApiError(400, "unsupported_file_type", "Unsupported file type");
  const dimensions = await imageDimensions(input);
  return { ...dimensions, ext, md5: md5Buffer(input), size: input.byteLength };
}

export async function createThumbnail(input: ImageInput) {
  const thumbnail = getThumbnailSettings();
  return sharp(input)
    .rotate()
    .resize({ width: thumbnail.long_edge, height: thumbnail.long_edge, fit: "inside", withoutEnlargement: true })
    .webp({ quality: thumbnail.quality })
    .toBuffer();
}

type ImageTranscodeSettings = {
  quality: number;
  quality_step: number;
  min_quality: number;
  max_long_edge: number;
  max_size_kb: number;
};

export type StoredImageTranscodeSettings = ImageTranscodeSettings & {
  skip_webp_under_kb: number;
};

export type PreparedStoredImage = {
  processed: Buffer;
  thumbnail: Buffer;
  sourceSize: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  ext: ImageExt;
  md5: string;
  size: number;
  quality: number | null;
  transcoded: boolean;
};

export async function transcodeStoredImage(path: string, settings: StoredImageTranscodeSettings): Promise<PreparedStoredImage> {
  const [sourceSize, sourceExt, dimensions] = await Promise.all([
    stat(path).then((value) => value.size),
    detectImageExt(path),
    imageDimensions(path)
  ]);
  if (!sourceExt) throw new ApiError(400, "unsupported_file_type", "Unsupported file type");
  // 小体积 WebP 且尺寸已达标时保留原字节，避免重复有损编码；缩略图仍重新生成，保证尺寸与配置一致。
  const canSkip = sourceExt === "webp"
    && sourceSize < settings.skip_webp_under_kb * 1024
    && Math.max(dimensions.width, dimensions.height) <= settings.max_long_edge;
  const thumbnailPromise = createThumbnail(path);
  const convertedPromise = canSkip
    ? readFile(path).then((buffer) => ({ buffer, quality: null as number | null, transcoded: false }))
    : transcodeImageToWebp(path, settings).then(({ buffer, quality }) => ({ buffer, quality, transcoded: true }));
  const [thumbnail, converted] = await Promise.all([thumbnailPromise, convertedPromise]);
  const probe = await probeImageBytes(converted.buffer);
  return {
    processed: converted.buffer,
    thumbnail,
    sourceSize,
    sourceWidth: dimensions.width,
    sourceHeight: dimensions.height,
    width: probe.width,
    height: probe.height,
    ext: probe.ext,
    md5: probe.md5,
    size: probe.size,
    quality: converted.quality,
    transcoded: converted.transcoded
  };
}

async function transcodeImageToWebp(input: ImageInput, settings: ImageTranscodeSettings) {
  const pipeline = sharp(input)
    .rotate()
    .resize({
      width: settings.max_long_edge,
      height: settings.max_long_edge,
      fit: "inside",
      withoutEnlargement: true
    });
  const maxBytes = Math.floor(settings.max_size_kb * 1024);
  let quality = settings.quality;
  let lastDropMultiplier = 1;
  const encode = (targetQuality: number) => pipeline.clone().webp({ quality: targetQuality }).toBuffer();
  const backfillQuality = async (buffer: Buffer, successfulQuality: number, attempts: number) => {
    let bestBuffer = buffer;
    let bestQuality = successfulQuality;
    for (let index = 0; index < attempts; index += 1) {
      const nextQuality = Math.min(settings.quality, bestQuality + settings.quality_step);
      if (nextQuality <= bestQuality) break;
      const candidate = await encode(nextQuality);
      if (candidate.byteLength > maxBytes) break;
      bestBuffer = candidate;
      bestQuality = nextQuality;
    }
    return { buffer: bestBuffer, quality: bestQuality };
  };
  while (true) {
    // sharp pipeline 在 toBuffer 后会被消费；每轮 clone 后降质量，直到达到体积目标或触底最低质量。
    const buffer = await encode(quality);
    if (quality <= settings.min_quality) {
      return { buffer, quality };
    }
    if (buffer.byteLength <= maxBytes) {
      return backfillQuality(buffer, quality, lastDropMultiplier - 1);
    }
    const overLimitMultiplier = Math.min(3, Math.max(1, Math.floor(buffer.byteLength / maxBytes)));
    lastDropMultiplier = overLimitMultiplier;
    quality = Math.max(settings.min_quality, quality - settings.quality_step * overLimitMultiplier);
  }
}

export async function generateStoredThumbnail(objectKey: string, storageSlug: string) {
  const config = await getStorageBackend(storageSlug);
  const input = config.type === "local" ? safeStoragePath("media", objectKey) : await readStorageBuffer("media", objectKey, storageSlug);
  const thumbnail = await createThumbnail(input);
  await writeStorageBuffer("thumbs", thumbnailObjectKey(objectKey), thumbnail, "image/webp", storageSlug);
  return thumbnail.byteLength;
}
