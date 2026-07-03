import { join, normalize, sep } from "node:path";
import { env } from "../config/env.js";
import { ApiError } from "../core/http.js";
import type { StorageConfig } from "../config/settings.js";

export const STORAGE_PREFIXES = ["objects", "thumbs", "_uploads", "link"] as const;
export type StoragePrefix = typeof STORAGE_PREFIXES[number];
export type ReadablePrefix = "objects" | "thumbs" | "link";

export const NAMESPACED_PREFIXES = STORAGE_PREFIXES.filter((prefix) => prefix !== "objects");

const reservedRootPrefixPattern = new RegExp(`^(${STORAGE_PREFIXES.join("|")})/`);
export function isReservedRootKey(key: string) {
  return reservedRootPrefixPattern.test(key);
}

export function storageObjectName(prefix: StoragePrefix, key: string) {
  // key 必须是对象存储里的相对路径；同时拒绝把 objects 根目录伪装成 thumbs/_uploads/link 命名空间。
  if (key.includes("\0") || key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  if (prefix === "objects" && isReservedRootKey(key)) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  return prefix === "objects" ? key : `${prefix}/${key}`;
}

export function safeStoragePath(prefix: StoragePrefix, key: string) {
  const base = env.STORAGE_DIR;
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
  // S3 列举需要目录式前缀；objects 在 root 下直存，其他命名空间都带 prefix/。
  return [s3RootPath(config), prefix === "objects" ? "" : `${prefix}/`].filter(Boolean).join("/").replace(/^(?!$)(.*[^/])$/, "$1/");
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
