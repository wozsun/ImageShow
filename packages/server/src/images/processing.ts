import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { ApiError } from "../core/api-error.ts";
import { getIngestionMaxLongEdge, getThumbnailSettings } from "../config/app-settings.ts";

const SHARP_THREADS_PER_IMAGE = 1;

export function configureSharpRuntime() {
  // Sharp/libvips otherwise keeps recently-opened file descriptors in its
  // cache. Linux permits unlinking those paths, but Windows leaves classified
  // or migrated local source objects permanently EBUSY. Object files are
  // immutable and already cached at higher layers, so descriptor caching has
  // no ownership benefit here.
  sharp.cache({ files: 0 });
  sharp.concurrency(SHARP_THREADS_PER_IMAGE);
}

type ImageInput = Buffer | string;
export type ImageExt = "jpg" | "png" | "webp" | "gif" | "avif";
type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;

type StoredImageMetadata = {
  ext: ImageExt;
  width: number;
  height: number;
};

function unsupportedFileTypeError() {
  return new ApiError(400, "unsupported_file_type", "Unsupported file type");
}

function normalizeSharpInputError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    throw error;
  }
  throw unsupportedFileTypeError();
}

function imageExtFromSharpMetadata(metadata: SharpMetadata): ImageExt | undefined {
  switch (metadata.format) {
    case "jpeg": return "jpg";
    case "png": return "png";
    case "webp": return "webp";
    case "gif": return "gif";
    case "heif": return metadata.compression === "av1" ? "avif" : undefined;
    default: return undefined;
  }
}

export function md5Buffer(input: Buffer) {
  return createHash("md5").update(input).digest("hex");
}

export function sha256Buffer(input: Buffer) {
  return createHash("sha256").update(input).digest("hex");
}

async function storedImageMetadata(path: string): Promise<StoredImageMetadata> {
  let metadata: SharpMetadata;
  try {
    metadata = await sharp(path).metadata();
  } catch (error) {
    normalizeSharpInputError(error);
  }
  const ext = imageExtFromSharpMetadata(metadata);
  if (!ext) throw unsupportedFileTypeError();

  // Sharp metadata 的宽高是原始像素方向；带 EXIF 旋转的手机图在展示时会互换宽高。
  // longEdge 仍按原始像素最大边校验，因为转码前解码压力取决于真实像素尺寸。
  const rawWidth = metadata.width;
  const rawHeight = metadata.height;
  const longEdge = Math.max(rawWidth, rawHeight);
  const limit = getIngestionMaxLongEdge();
  if (
    !Number.isSafeInteger(rawWidth)
    || !Number.isSafeInteger(rawHeight)
    || rawWidth <= 0
    || rawHeight <= 0
    || longEdge > limit
  ) {
    throw new ApiError(400, "image_too_large", "图片尺寸超过限制", { limit });
  }
  const rotated = typeof metadata.orientation === "number"
    && metadata.orientation >= 5
    && metadata.orientation <= 8;
  return {
    ext,
    width: rotated ? rawHeight : rawWidth,
    height: rotated ? rawWidth : rawHeight
  };
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
  const [sourceSize, source] = await Promise.all([
    stat(path).then((value) => value.size),
    storedImageMetadata(path)
  ]);
  // 小体积 WebP 且尺寸已达标时保留原字节，避免重复有损编码；缩略图仍重新生成，保证尺寸与配置一致。
  const canSkip = source.ext === "webp"
    && sourceSize < settings.skip_webp_under_kb * 1024
    && Math.max(source.width, source.height) <= settings.max_long_edge;
  const thumbnailPromise = createThumbnail(path);
  const convertedPromise = canSkip
    ? readFile(path).then((buffer) => ({
        buffer,
        width: source.width,
        height: source.height,
        size: buffer.byteLength,
        quality: null as number | null,
        transcoded: false
      }))
    : transcodeImageToWebp(path, settings).then(({ data, info, quality }) => ({
        buffer: data,
        width: info.width,
        height: info.height,
        size: info.size,
        quality,
        transcoded: true
      }));
  const [thumbnailResult, convertedResult] = await Promise.allSettled([
    thumbnailPromise,
    convertedPromise
  ]);
  if (thumbnailResult.status === "rejected") {
    normalizeSharpInputError(thumbnailResult.reason);
  }
  if (convertedResult.status === "rejected") {
    normalizeSharpInputError(convertedResult.reason);
  }
  const thumbnail = thumbnailResult.value;
  const converted = convertedResult.value;
  return {
    processed: converted.buffer,
    thumbnail,
    sourceSize,
    sourceWidth: source.width,
    sourceHeight: source.height,
    width: converted.width,
    height: converted.height,
    ext: "webp",
    md5: md5Buffer(converted.buffer),
    size: converted.size,
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
  const encode = (targetQuality: number) => pipeline
    .clone()
    .webp({ quality: targetQuality })
    .toBuffer({ resolveWithObject: true });
  const backfillQuality = async (
    encoded: Awaited<ReturnType<typeof encode>>,
    successfulQuality: number,
    attempts: number
  ) => {
    let best = encoded;
    let bestQuality = successfulQuality;
    for (let index = 0; index < attempts; index += 1) {
      const nextQuality = Math.min(settings.quality, bestQuality + settings.quality_step);
      if (nextQuality <= bestQuality) break;
      const candidate = await encode(nextQuality);
      if (candidate.info.size > maxBytes) break;
      best = candidate;
      bestQuality = nextQuality;
    }
    return { ...best, quality: bestQuality };
  };
  while (true) {
    // sharp pipeline 在 toBuffer 后会被消费；每轮 clone 后降质量，直到达到体积目标或触底最低质量。
    const encoded = await encode(quality);
    if (quality <= settings.min_quality) {
      return { ...encoded, quality };
    }
    if (encoded.info.size <= maxBytes) {
      return backfillQuality(encoded, quality, lastDropMultiplier - 1);
    }
    const overLimitMultiplier = Math.min(3, Math.max(1, Math.floor(encoded.info.size / maxBytes)));
    lastDropMultiplier = overLimitMultiplier;
    quality = Math.max(settings.min_quality, quality - settings.quality_step * overLimitMultiplier);
  }
}
