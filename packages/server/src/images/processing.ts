import { createHash } from "node:crypto";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import sharp from "sharp";
import { type ImageExt } from "@imageshow/shared";
import { ApiError } from "../core/http.js";
import { getRuntimeConfig } from "../config/env.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { getDefaultStorageSlug, getImageMaxLongEdge, getStorageBackend, getThumbnailSettings, getUploadLimitBytes } from "../config/settings.js";

// Pin libvips' per-operation thread pool to the shared upload/thumbnail concurrency knob
// (upload.concurrency, which also bounds the thumb.generate worker lanes). Without this, each
// sharp call fans out to every CPU core, so several concurrent thumbnail jobs spawn cores²
// native threads and spike memory; matching sharp's internal threads to the same number keeps
// total native parallelism bounded. Called at startup and re-applied on config hot-reload
// (wired from the composition root in index.ts).
export function applyImageConcurrency() {
  sharp.concurrency(Math.max(1, getRuntimeConfig().upload.concurrency));
}
import {
  openStorageRead,
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

export function md5Buffer(input: Buffer) {
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

export async function calculateObjectMd5(prefix: StoragePrefix, key: string, slug?: string) {
  const opened = await openStorageRead(prefix, key, slug);
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

// Validates raw image bytes (an uploaded buffer, or one fetched from an imported
// link) and returns the fields a metadata row needs. Enforces the long-edge limit
// via imageDimensions.
export async function probeImageBytes(input: Buffer) {
  const ext = await detectImageExt(input);
  if (!ext) throw new ApiError(400, "unsupported_file_type", "Unsupported file type");
  const dimensions = await imageDimensions(input);
  return { ...dimensions, ext, md5: md5Buffer(input), size: input.byteLength };
}

// Infers the device axis from image dimensions, matching the uploader's
// width >= height => pc heuristic. Used by link import, where there's no client to
// detect it. (Brightness has no dimension-based equivalent — auto-brightness would
// analyze the decoded image bytes separately.)
export function detectDeviceFromDimensions(width: number, height: number): "pc" | "mb" {
  return width >= height ? "pc" : "mb";
}

export async function createThumbnail(input: ImageInput) {
  const thumbnail = getThumbnailSettings();
  return sharp(input)
    .rotate()
    .resize({ width: thumbnail.long_edge, height: thumbnail.long_edge, fit: "inside", withoutEnlargement: true })
    .webp({ quality: thumbnail.quality })
    .toBuffer();
}

// Returns the generated thumbnail's byte size so callers can record it for
// storage-usage stats. (Lazy-serve regenerations ignore the return value.)
export async function makeThumb(objectKey: string, slug?: string) {
  const targetSlug = slug ?? await getDefaultStorageSlug();
  const config = await getStorageBackend(targetSlug);
  // Local objects are thumbnailed straight from disk; remote backends are read into a
  // buffer first.
  const input = config.type === "local" ? safeStoragePath("objects", objectKey) : await readStorageBuffer("objects", objectKey, targetSlug);
  const thumbnail = await createThumbnail(input);
  await writeStorageBuffer("thumbs", thumbnailObjectKey(objectKey), thumbnail, "image/webp", targetSlug);
  return thumbnail.byteLength;
}
