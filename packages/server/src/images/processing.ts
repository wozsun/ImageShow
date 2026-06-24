import { createHash } from "node:crypto";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import sharp from "sharp";
import { appConfig, type ImageExt } from "@imageshow/shared";
import { ApiError } from "../core/http.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { getImageMaxLongEdge, getStorageConfig, getUploadLimitBytes, type StorageBackend } from "../config/settings.js";
import {
  openStorageRead,
  objectStat,
  readStorageBuffer,
  safeStoragePath,
  writeStorageBuffer,
  type StoragePrefix
} from "../storage/storage.js";

type ImageInput = Buffer | string;

function normalizeImageExt(ext?: string): ImageExt | undefined {
  const value = ext === "jpeg" ? "jpg" : ext;
  return value && ["jpg", "png", "webp", "gif", "avif"].includes(value) ? value as ImageExt : undefined;
}

async function detectImageExt(input: ImageInput) {
  const detected = typeof input === "string" ? await fileTypeFromFile(input) : await fileTypeFromBuffer(input);
  return normalizeImageExt(detected?.ext);
}

function md5Buffer(input: Buffer) {
  return createHash("md5").update(input).digest("hex");
}

async function imageDimensions(input: ImageInput) {
  const meta = await sharp(input).metadata();
  const rotated = typeof meta.orientation === "number" && meta.orientation >= 5 && meta.orientation <= 8;
  const width = rotated ? meta.height ?? 0 : meta.width ?? 0;
  const height = rotated ? meta.width ?? 0 : meta.height ?? 0;
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const limit = await getImageMaxLongEdge();
  if (!longEdge || longEdge > limit) {
    throw new ApiError(400, "image_too_large", "Image dimensions exceed the configured limit", { limit });
  }
  return { width, height };
}

export async function calculateObjectMd5(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  const opened = await openStorageRead(prefix, key, backend);
  const limit = opened.backend === "s3" ? await getUploadLimitBytes() : undefined;
  if (limit !== undefined && opened.size !== undefined && opened.size > limit) {
    opened.body.destroy();
    throw new ApiError(400, "object_too_large", "Object is too large to buffer safely", { limit });
  }
  const hash = createHash("md5");
  let total = 0;
  try {
    for await (const chunk of opened.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (limit !== undefined && total > limit) {
        throw new ApiError(400, "object_too_large", "Object is too large to buffer safely", { limit });
      }
      hash.update(buffer);
    }
    return hash.digest("hex");
  } catch (error) {
    opened.body.destroy();
    throw error;
  }
}

export async function validateImage(prefix: StoragePrefix, key: string, expectedExt: ImageExt, backend?: StorageBackend) {
  const effective = backend ?? (await getStorageConfig()).backend;
  const input = effective === "s3" ? await readStorageBuffer(prefix, key, effective) : safeStoragePath(prefix, key);
  const actualExt = await detectImageExt(input);
  if (!actualExt) throw new ApiError(400, "unsupported_file_type", "Unsupported file type");
  if (actualExt !== expectedExt) {
    throw new ApiError(400, "extension_mismatch", "File extension does not match image content", { expected: expectedExt, actual: actualExt });
  }
  const dimensions = await imageDimensions(input);
  let size: number;
  if (typeof input === "string") {
    const limit = await getUploadLimitBytes();
    size = (await objectStat(prefix, key, effective)).size;
    if (size > limit) {
      throw new ApiError(400, "upload_too_large", "Upload too large", { limit });
    }
  } else {
    size = input.byteLength;
  }
  const md5 = Buffer.isBuffer(input) ? md5Buffer(input) : await calculateObjectMd5(prefix, key, effective);
  return { ...dimensions, ext: actualExt, md5, size };
}

export async function createThumbnail(input: ImageInput) {
  return sharp(input)
    .rotate()
    .resize({ width: appConfig.thumbnail.longEdge, height: appConfig.thumbnail.longEdge, fit: "inside", withoutEnlargement: true })
    .webp({ quality: appConfig.thumbnail.quality })
    .toBuffer();
}

export async function makeThumb(objectKey: string, backend?: StorageBackend) {
  const effective = backend ?? (await getStorageConfig()).backend;
  const input = effective === "s3" ? await readStorageBuffer("objects", objectKey, effective) : safeStoragePath("objects", objectKey);
  await writeStorageBuffer("thumbs", thumbnailObjectKey(objectKey), await createThumbnail(input), "image/webp", effective);
}

export function contentType(ext: string) {
  if (ext === "jpg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  return "application/octet-stream";
}
