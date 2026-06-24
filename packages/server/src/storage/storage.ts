// Storage abstraction over local disk and S3-compatible object storage. Every
// object name flows through storageObjectName/safeStoragePath so URLs, listings
// and deletes agree and path traversal is rejected.
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { adminApiBasePath } from "@imageshow/shared";
import { env, getRuntimeConfig } from "../config/env.js";
import { ApiError } from "../core/http.js";
import { thumbnailObjectKey } from "./image-paths.js";
import { staticLocalBaseUrl } from "../core/theme-host.js";
import { getPresignExpiresSeconds, getStorageConfig, getUploadLimitBytes, missingS3Fields, type StorageBackend, type StorageConfig } from "../config/settings.js";
import { limitedWebStream, nodeReadableFromWeb, streamToBuffer } from "./stream-buffer.js";

export type StoragePrefix = "objects" | "thumbs" | "_uploads" | "trash";
type ReadablePrefix = "objects" | "thumbs";

export async function ensureStorage() {
  await mkdir(env.CONFIG_DIR, { recursive: true });
  await mkdir(env.STORAGE_DIR, { recursive: true });
  for (const dir of ["thumbs", "_uploads", "trash"]) {
    await mkdir(join(env.STORAGE_DIR, dir), { recursive: true });
  }
}

export function safeStoragePath(prefix: StoragePrefix, key: string) {
  const base = env.STORAGE_DIR;
  const resolved = normalize(join(base, storageObjectName(prefix, key)));
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  return resolved;
}

function storageObjectName(prefix: StoragePrefix, key: string) {
  if (key.includes("\0") || key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  if (prefix === "objects" && /^(objects|thumbs|_uploads|trash)\//.test(key)) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  return prefix === "objects" ? key : `${prefix}/${key}`;
}

function s3RootPath(config: StorageConfig) {
  return (config.s3.root_path ?? "/").replace(/^\/+|\/+$/g, "");
}

// All S3 operations go through this mapper so object URLs, lists, and deletes agree.
export function storageS3ObjectName(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return [s3RootPath(config), storageObjectName(prefix, key)].filter(Boolean).join("/");
}

// Listing needs the directory-style prefix rather than a concrete object name.
function s3ListPrefix(config: StorageConfig, prefix: StoragePrefix) {
  return [s3RootPath(config), prefix === "objects" ? "" : `${prefix}/`].filter(Boolean).join("/").replace(/^(?!$)(.*[^/])$/, "$1/");
}

function copySource(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return `${config.s3.bucket}/${storageS3ObjectName(config, prefix, key).split("/").map(encodeURIComponent).join("/")}`;
}

export function storageS3Client(config: StorageConfig) {
  const endpoint = /^https?:\/\//i.test(config.s3.endpoint) ? config.s3.endpoint : `https://${config.s3.endpoint}`;
  return new S3Client({
    endpoint,
    region: config.s3.region || "auto",
    forcePathStyle: config.s3.force_path_style,
    credentials: {
      accessKeyId: config.s3.access_key_id,
      secretAccessKey: config.s3.secret_access_key ?? ""
    }
  });
}

// Resolves the config for a specific image's backend. Without a backend it uses
// the saved default (new uploads); with one it derives that backend's config
// WITHOUT requiring S3 credentials, so a misconfigured backend fails per-object
// (e.g. 404) instead of breaking the whole instance.
async function resolveConfig(backend?: StorageBackend) {
  const config = await getStorageConfig();
  return backend ? storageConfigForBackendUnchecked(config, backend) : config;
}

function requireS3Ready(config: StorageConfig) {
  const missing = missingS3Fields(config.s3);
  if (missing.length) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
}

// Derives a backend's config (shallow copy) without validating S3 credentials.
export function storageConfigForBackendUnchecked(config: StorageConfig, backend: StorageBackend) {
  return { ...config, backend, s3: { ...config.s3 } };
}

export function storageConfigForBackend(config: StorageConfig, backend: "local" | "s3") {
  const next = storageConfigForBackendUnchecked(config, backend);
  if (backend === "s3") {
    next.s3.enabled = true;
    requireS3Ready(next);
  }
  return next;
}

export async function storageExistsWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  if (config.backend === "s3") {
    try {
      await storageS3Client(config).send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: storageS3ObjectName(config, prefix, key) }));
      return true;
    } catch {
      return false;
    }
  }
  try {
    await access(safeStoragePath(prefix, key));
    return true;
  } catch {
    return false;
  }
}

export async function openStorageReadWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  if (config.backend === "s3") {
    const result = await storageS3Client(config).send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: storageS3ObjectName(config, prefix, key)
    }));
    const body = result.Body as Readable | undefined;
    if (!body) throw new ApiError(502, "storage_read_failed", "Storage returned an empty response body");
    const rawSize = Number(result.ContentLength);
    return { body, size: Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : undefined, backend: "s3" as const };
  }
  const path = safeStoragePath(prefix, key);
  const size = (await stat(path)).size;
  return { body: createReadStream(path), size, backend: "local" as const };
}

export async function openStorageRead(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return openStorageReadWithConfig(await resolveConfig(backend), prefix, key);
}

export async function readStorageBufferWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  if (config.backend === "s3") {
    const limit = await getUploadLimitBytes();
    const opened = await openStorageReadWithConfig(config, prefix, key);
    if (opened.size !== undefined && opened.size > limit) {
      opened.body.destroy();
      throw new ApiError(400, "object_too_large", "Object is too large to buffer safely", { limit });
    }
    try {
      return await streamToBuffer(opened.body, limit);
    } catch (error) {
      opened.body.destroy();
      throw error;
    }
  }
  return readFile(safeStoragePath(prefix, key));
}

export async function readStorageBuffer(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return readStorageBufferWithConfig(await resolveConfig(backend), prefix, key);
}

export async function writeStorageBufferWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string, body: Buffer, type: string) {
  if (config.backend === "s3") {
    await storageS3Client(config).send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: storageS3ObjectName(config, prefix, key),
      Body: body,
      ContentType: type
    }));
    return;
  }
  const target = safeStoragePath(prefix, key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

export async function writeStorageBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string, backend?: StorageBackend) {
  return writeStorageBufferWithConfig(await resolveConfig(backend), prefix, key, body, type);
}

export async function publicObjectUrl(prefix: ReadablePrefix, key: string, backend?: StorageBackend) {
  const config = await resolveConfig(backend);
  return publicObjectUrlWithConfig(config, prefix, key);
}

function publicObjectUrlWithConfig(config: StorageConfig, prefix: ReadablePrefix, key: string) {
  if (config.backend !== "s3" || !config.s3.public_base_url) return "";
  const base = config.s3.public_base_url.replace(/\/+$/, "");
  const encoded = storageS3ObjectName(config, prefix, key).split("/").map(encodeURIComponent).join("/");
  return `${base}/${encoded}`;
}

function localMediaUrl(prefix: ReadablePrefix, key: string) {
  const route = prefix === "objects" ? "media" : "thumbs";
  return `/${route}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export async function publicImageUrls(objectKey: string, backend: StorageBackend) {
  const config = await resolveConfig(backend);
  const thumbKey = thumbnailObjectKey(objectKey);
  // Anything without an S3 public URL (local, or S3 without public_base_url) is
  // served from the cookie-isolated static.<domain> host's /media and /thumbs routes.
  const staticBase = staticLocalBaseUrl();
  return {
    object_url: publicObjectUrlWithConfig(config, "objects", objectKey) || `${staticBase}${localMediaUrl("objects", objectKey)}`,
    thumb_url: publicObjectUrlWithConfig(config, "thumbs", thumbKey) || `${staticBase}${localMediaUrl("thumbs", thumbKey)}`
  };
}

export async function createUploadTarget(row: { id: string; staging_object_key: string; expected_size: number; expires_at: Date | string; storage_backend: StorageBackend; content_md5_hex?: string }) {
  // Resolve the session's own backend (not just the current default) so a batch
  // pinned to a specific location uploads there. S3 credentials were validated
  // when the session was created.
  const base = await getStorageConfig();
  const config = row.storage_backend === "s3" ? storageConfigForBackend(base, "s3") : storageConfigForBackendUnchecked(base, "local");
  const expiresAt = new Date(row.expires_at).getTime();
  if (config.backend === "s3") {
    // Sign a Content-MD5 header so the object store validates the uploaded bytes
    // and rejects corruption in transit (BadDigest). The browser must replay the
    // exact header, so it's returned in upload_headers; this needs the bucket CORS
    // to allow Content-MD5. The hex digest the browser already computed is encoded
    // to the base64 form S3/COS expect.
    const contentMd5 = getRuntimeConfig().upload.verify_content_md5 && row.content_md5_hex && /^[a-f0-9]{32}$/.test(row.content_md5_hex)
      ? Buffer.from(row.content_md5_hex, "hex").toString("base64")
      : undefined;
    const command = new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: storageS3ObjectName(config, "_uploads", row.staging_object_key),
      ...(contentMd5 ? { ContentMD5: contentMd5 } : {})
    });
    const seconds = Math.max(60, Math.min(await getPresignExpiresSeconds(), Math.floor((expiresAt - Date.now()) / 1000)));
    return {
      upload_url: await getSignedUrl(storageS3Client(config), command, { expiresIn: seconds }),
      upload_headers: contentMd5 ? { "Content-MD5": contentMd5 } : {},
      backend: "s3-direct"
    };
  }
  // Local storage has no browser-addressable object endpoint, so it keeps the
  // same PUT flow against the app. The browser sends it same-origin with the admin
  // session cookie + CSRF header, so no separate upload token is needed.
  return {
    upload_url: `${adminApiBasePath}/uploads/${row.id}/file`,
    upload_headers: {},
    backend: config.backend
  };
}

export async function exists(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return storageExistsWithConfig(await resolveConfig(backend), prefix, key);
}

export async function removeObject(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  const config = await resolveConfig(backend);
  if (config.backend === "s3") {
    await storageS3Client(config).send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: storageS3ObjectName(config, prefix, key) }));
    return;
  }
  await rm(safeStoragePath(prefix, key), { force: true });
}

export async function moveObject(fromPrefix: "objects" | "_uploads" | "trash", fromKey: string, toPrefix: "objects" | "trash", toKey: string, targetContentType?: string, backend?: StorageBackend) {
  const config = await resolveConfig(backend);
  if (config.backend === "s3") {
    const client = storageS3Client(config);
    await client.send(new CopyObjectCommand({
      Bucket: config.s3.bucket,
      CopySource: copySource(config, fromPrefix, fromKey),
      Key: storageS3ObjectName(config, toPrefix, toKey),
      ...(targetContentType ? { ContentType: targetContentType, MetadataDirective: "REPLACE" as const } : {})
    }));
    await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: storageS3ObjectName(config, fromPrefix, fromKey) }));
    return;
  }
  const source = safeStoragePath(fromPrefix, fromKey);
  const target = safeStoragePath(toPrefix, toKey);
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (!["EXDEV", "EBUSY", "EPERM"].includes(code ?? "")) throw error;
    // Windows development and cross-device volumes can make rename unreliable
    // immediately after image inspection. Copy+remove keeps complete idempotent.
    await copyFile(source, target);
    await rm(source, { force: true }).catch(() => undefined);
  }
}

export async function copyObject(fromPrefix: "objects" | "thumbs" | "trash", fromKey: string, toPrefix: "objects" | "thumbs" | "trash", toKey: string, backend?: StorageBackend) {
  const config = await resolveConfig(backend);
  if (config.backend === "s3") {
    await storageS3Client(config).send(new CopyObjectCommand({
      Bucket: config.s3.bucket,
      CopySource: copySource(config, fromPrefix, fromKey),
      Key: storageS3ObjectName(config, toPrefix, toKey)
    }));
    return;
  }
  const source = safeStoragePath(fromPrefix, fromKey);
  const target = safeStoragePath(toPrefix, toKey);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

export async function objectStat(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return objectStatWithConfig(await resolveConfig(backend), prefix, key);
}

async function objectStatWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  if (config.backend === "s3") {
    const result = await storageS3Client(config).send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: storageS3ObjectName(config, prefix, key) }));
    return { size: Number(result.ContentLength ?? 0) };
  }
  return stat(safeStoragePath(prefix, key));
}

export async function writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number, backend?: StorageBackend) {
  const config = await resolveConfig(backend);
  if (config.backend === "s3") {
    // Stream straight to S3 with a known length instead of buffering the whole
    // body in memory. The size cap is enforced inline; the exact-size and MD5
    // checks still run against the stored object during upload completion.
    await storageS3Client(config).send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: storageS3ObjectName(config, "_uploads", id),
      Body: nodeReadableFromWeb(limitedWebStream(body, expectedSize)),
      ContentLength: expectedSize,
      ContentType: "application/octet-stream"
    }));
    return;
  }
  const part = safeStoragePath("_uploads", `${id}.part`);
  const final = safeStoragePath("_uploads", id);
  await mkdir(dirname(final), { recursive: true });
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > expectedSize) throw new ApiError(400, "upload_too_large", "Upload too large");
      controller.enqueue(chunk);
    }
  });
  await pipeline(nodeReadableFromWeb(body.pipeThrough(limiter)), createWriteStream(part));
  if (total !== expectedSize) throw new ApiError(400, "size_mismatch", "Upload size mismatch", { expected: expectedSize, actual: total });
  await rename(part, final);
}

export async function readObject(prefix: ReadablePrefix, key: string, backend?: StorageBackend) {
  const config = await resolveConfig(backend);
  if (config.backend === "s3") {
    const result = await storageS3Client(config).send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: storageS3ObjectName(config, prefix, key) }));
    return result.Body as Readable;
  }
  return createReadStream(safeStoragePath(prefix, key));
}

export async function listStorageKeys(prefix: StoragePrefix, backend?: StorageBackend) {
  const config = await resolveConfig(backend);
  if (config.backend === "s3") {
    const keys: string[] = [];
    const client = storageS3Client(config);
    let token: string | undefined;
    do {
      const prefixPath = s3ListPrefix(config, prefix);
      const result = await client.send(new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: prefixPath,
        ContinuationToken: token
      }));
      for (const item of result.Contents ?? []) {
        if (!item.Key || item.Key === prefixPath) continue;
        const key = item.Key.startsWith(prefixPath) ? item.Key.slice(prefixPath.length) : item.Key;
        if (prefix === "objects" && /^(thumbs|_uploads|trash)\//.test(key)) continue;
        keys.push(key);
      }
      token = result.NextContinuationToken;
    } while (token);
    return keys;
  }
  const root = prefix === "objects" ? env.STORAGE_DIR : join(env.STORAGE_DIR, prefix);
  const keys: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (prefix === "objects" && dir === root && entry.isDirectory() && ["objects", "thumbs", "_uploads", "trash"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const key = relative(root, path).split(sep).join("/");
        if (prefix === "objects" && /^(thumbs|_uploads|trash|objects)\//.test(key)) continue;
        keys.push(key);
      }
    }
  }
  await walk(root);
  return keys;
}

export async function testStorage(config?: StorageConfig) {
  const effective = config ?? await getStorageConfig();
  if (effective.backend !== "s3") {
    await ensureStorage();
    await writeFile(safeStoragePath("_uploads", ".storage-test"), "ok");
    await removeObject("_uploads", ".storage-test");
    return { backend: "local", writable: true, storage_dir: env.STORAGE_DIR };
  }
  const missing = missingS3Fields(effective.s3);
  if (missing.length) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
  const client = storageS3Client(effective);
  const key = storageS3ObjectName(effective, "_uploads", `.storage-test-${Date.now()}`);
  await client.send(new PutObjectCommand({ Bucket: effective.s3.bucket, Key: key, Body: "ok", ContentType: "text/plain" }));
  await client.send(new HeadObjectCommand({ Bucket: effective.s3.bucket, Key: key }));
  await client.send(new DeleteObjectCommand({ Bucket: effective.s3.bucket, Key: key }));
  return {
    backend: "s3",
    writable: true,
    bucket: effective.s3.bucket,
    endpoint: effective.s3.endpoint,
    public_base_url: effective.s3.public_base_url
  };
}
