import { join, normalize, sep } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { ApiError } from "../core/api-error.ts";
import type { StorageConfig } from "./backend-config.ts";

export const STORAGE_PREFIXES = ["media", "thumbs", "_uploads"] as const;
export type StoragePrefix = typeof STORAGE_PREFIXES[number];
export type ReadablePrefix = "media" | "thumbs";

const reservedRootPrefixPattern = new RegExp(`^(${STORAGE_PREFIXES.join("|")})/`);
function isReservedRootKey(key: string) {
  return reservedRootPrefixPattern.test(key);
}

export function storageObjectName(prefix: StoragePrefix, key: string) {
  // key 只表达业务路径，实际对象路径统一加命名空间前缀，避免不同用途的对象混在根目录。
  if (key.includes("\0") || key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  if (isReservedRootKey(key)) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  return `${prefix}/${key}`;
}

export function safeStoragePath(prefix: StoragePrefix, key: string) {
  const base = runtimePaths.storageDirectory;
  const resolved = normalize(join(base, storageObjectName(prefix, key)));
  // join/normalize 后再做前缀校验，抵御反斜杠、重复分隔符等平台路径差异导致的目录逃逸。
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  return resolved;
}

function s3RootPath(config: StorageConfig) {
  return (config.s3.root_path ?? "/").replace(/^\/+|\/+$/g, "");
}

export function storageS3ObjectName(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return [s3RootPath(config), storageObjectName(prefix, key)].filter(Boolean).join("/");
}

export function s3ListPrefix(config: StorageConfig, prefix: StoragePrefix) {
  return [s3RootPath(config), `${prefix}/`].filter(Boolean).join("/").replace(/^(?!$)(.*[^/])$/, "$1/");
}

export function s3CopySource(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return `${config.s3.bucket}/${storageS3ObjectName(config, prefix, key).split("/").map(encodeURIComponent).join("/")}`;
}

export function contentType(ext: string): string {
  if (ext === "jpg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  return "application/octet-stream";
}

export function contentTypeForKey(key: string): string {
  return contentType(key.slice(key.lastIndexOf(".") + 1).toLowerCase());
}
