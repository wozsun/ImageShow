import { normalize, resolve } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import type { StorageConfig } from "./backend-config.ts";

function normalizedRootPath(value: string) {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function canonicalHttpsEndpoint(value: string) {
  if (!value.trim()) return "";
  const withProtocol = /^https:\/\//i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  const endpoint = new URL(withProtocol);
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/g, "") || "/";
  return endpoint.toString().replace(/\/$/, "");
}

function canonicalWebdavRoot(config: StorageConfig) {
  const base = config.webdav.base_url.trim().replace(/\/+$/g, "");
  const root = normalizedRootPath(config.webdav.root_path);
  if (!base) return root;
  const encodedRoot = root
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const location = new URL(encodedRoot ? `${base}/${encodedRoot}` : base);
  location.hash = "";
  location.pathname = location.pathname.replace(/\/+$/g, "") || "/";
  return location.toString().replace(/\/$/, "");
}

/**
 * Return an opaque identity for the physical namespace that owns every
 * `media/`, `thumbs/` and `_uploads/` key. Credentials, public URLs,
 * timeouts and display settings intentionally do not participate.
 */
export function storageNamespaceIdentity(config: StorageConfig) {
  if (config.type === "s3") {
    return JSON.stringify([
      "s3",
      canonicalHttpsEndpoint(config.s3.endpoint),
      config.s3.bucket.trim(),
      normalizedRootPath(config.s3.root_path)
    ]);
  }
  if (config.type === "webdav") {
    return JSON.stringify(["webdav", canonicalWebdavRoot(config)]);
  }

  const localRoot = normalize(resolve(runtimePaths.storageDirectory));
  return JSON.stringify([
    "local",
    process.platform === "win32" ? localRoot.toLowerCase() : localRoot
  ]);
}

export function shareStorageNamespace(source: StorageConfig, target: StorageConfig) {
  return storageNamespaceIdentity(source) === storageNamespaceIdentity(target);
}
