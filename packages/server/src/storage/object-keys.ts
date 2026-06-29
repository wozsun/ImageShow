// Pure key/path mapping shared by the storage backends. No I/O and no clients
// live here: every object name flows through these helpers so URLs, listings and
// deletes agree, and path traversal is rejected before it reaches disk or S3.
import { join, normalize, sep } from "node:path";
import { env } from "../config/env.js";
import { ApiError } from "../core/http.js";
import type { StorageConfig } from "../config/settings.js";

// "link" is a top-level prefix (sibling to thumbs/trash) holding link-image
// thumbnails, kept separate from regular object thumbnails.
export type StoragePrefix = "objects" | "thumbs" | "_uploads" | "trash" | "link";
export type ReadablePrefix = "objects" | "thumbs" | "link";

// Maps a (prefix, key) pair to its stored object name. "objects" live at the
// storage root; the other prefixes are namespaced under a directory of that name.
// Rejects NUL/traversal and keys that would escape their prefix.
export function storageObjectName(prefix: StoragePrefix, key: string) {
  if (key.includes("\0") || key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  if (prefix === "objects" && /^(objects|thumbs|_uploads|trash|link)\//.test(key)) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  return prefix === "objects" ? key : `${prefix}/${key}`;
}

// Absolute on-disk path for a local object, guaranteed to stay within STORAGE_DIR.
export function safeStoragePath(prefix: StoragePrefix, key: string) {
  const base = env.STORAGE_DIR;
  const resolved = normalize(join(base, storageObjectName(prefix, key)));
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  return resolved;
}

function s3RootPath(config: StorageConfig) {
  return (config.s3.root_path ?? "/").replace(/^\/+|\/+$/g, "");
}

// All S3 operations go through this mapper so object URLs, lists, and deletes agree.
export function storageS3ObjectName(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return [s3RootPath(config), storageObjectName(prefix, key)].filter(Boolean).join("/");
}

// Listing needs the directory-style prefix rather than a concrete object name.
export function s3ListPrefix(config: StorageConfig, prefix: StoragePrefix) {
  return [s3RootPath(config), prefix === "objects" ? "" : `${prefix}/`].filter(Boolean).join("/").replace(/^(?!$)(.*[^/])$/, "$1/");
}

export function s3CopySource(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return `${config.s3.bucket}/${storageS3ObjectName(config, prefix, key).split("/").map(encodeURIComponent).join("/")}`;
}
