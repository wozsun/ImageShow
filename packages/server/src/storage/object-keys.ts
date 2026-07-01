// Pure key/path mapping shared by the storage backends. No I/O and no clients
// live here: every object name flows through these helpers so URLs, listings and
// deletes agree, and path traversal is rejected before it reaches disk or S3.
import { join, normalize, sep } from "node:path";
import { env } from "../config/env.js";
import { ApiError } from "../core/http.js";
import type { StorageConfig } from "../config/settings.js";

// All storage prefixes. "objects" (the original images) lives at the storage root; the rest
// ("thumbs" / "_uploads" / "link") are each namespaced under a dir of that name ("link" =
// link-image thumbnails, kept apart from object thumbnails). The type and the reserved-name guards
// below both derive from this array, so adding a prefix stays in sync everywhere.
export const STORAGE_PREFIXES = ["objects", "thumbs", "_uploads", "link"] as const;
export type StoragePrefix = typeof STORAGE_PREFIXES[number];
export type ReadablePrefix = "objects" | "thumbs" | "link";

// Prefixes that live under their own directory (everything except root-level "objects"). Used to
// create / protect those dirs and to skip them when enumerating root-level objects.
export const NAMESPACED_PREFIXES = STORAGE_PREFIXES.filter((prefix) => prefix !== "objects");

// True when a key would sit under a reserved prefix folder at the storage root. Two uses: (1) the
// write-name guard rejects an "objects" key shaped like a reserved folder so a root original can't
// shadow or escape into one; (2) root "objects" listings skip these, so sibling thumbs/_uploads/link
// aren't mistaken for originals.
const reservedRootPrefixPattern = new RegExp(`^(${STORAGE_PREFIXES.join("|")})/`);
export function isReservedRootKey(key: string) {
  return reservedRootPrefixPattern.test(key);
}

// Maps a (prefix, key) pair to its stored object name. "objects" live at the storage root; the
// other prefixes are namespaced under a directory of that name. Rejects NUL/traversal and keys
// that would escape their prefix.
export function storageObjectName(prefix: StoragePrefix, key: string) {
  if (key.includes("\0") || key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
    throw new ApiError(400, "unsafe_path", "Unsafe storage path");
  }
  if (prefix === "objects" && isReservedRootKey(key)) {
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

// Content-type for a stored image by its extension. Lives in this dependency-free module (rather
// than images/processing, which pulls in sharp) so the byte-serving paths and the storage facade's
// copy fallback share one MIME source. Unknown / extension-less falls back to octet-stream.
export function contentType(ext: string): string {
  if (ext === "jpg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  return "application/octet-stream";
}

// Content-type derived from a stored object key's extension (thumbs/link are always .webp; objects
// carry the original ext). Used by the copy fallback, which re-writes the object and must label it.
export function contentTypeForKey(key: string): string {
  return contentType(key.slice(key.lastIndexOf(".") + 1).toLowerCase());
}
