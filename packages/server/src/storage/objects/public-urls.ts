import { imageVariantUrl, type ImageVariant } from "@imageshow/shared/browser";
import { imageResourceBaseUrl } from "../../config/site-host.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { assertLocalPublicUrlDomain, type StorageConfig } from "../backends/config.ts";
import { publishedStorageBackends } from "../backends/registry.ts";
import { storageS3ObjectName, type ReadablePrefix } from "./keys.ts";

function encodeKeyPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function directStorageObjectUrl(config: StorageConfig, prefix: ReadablePrefix, key: string) {
  if (config.type === "local") {
    if (!config.public_base_url) return "";
    assertLocalPublicUrlDomain(config.public_base_url, getRuntimeConfig().site);
    return `${config.public_base_url.replace(/\/+$/, "")}/${prefix}/${encodeKeyPath(key)}`;
  }
  if (!config.s3.public_base_url) return "";
  return `${config.s3.public_base_url.replace(/\/+$/, "")}/${encodeKeyPath(storageS3ObjectName(config, prefix, key))}`;
}

export function publicImageBaseUrl(config: StorageConfig) {
  if (config.type === "local" && config.public_base_url) {
    assertLocalPublicUrlDomain(config.public_base_url, getRuntimeConfig().site);
    return config.public_base_url.replace(/\/+$/, "");
  }
  if (config.type === "s3" && config.s3.public_base_url) {
    const root = (config.s3.root_path ?? "").replace(/^\/+|\/+$/g, "");
    return `${config.s3.public_base_url.replace(/\/+$/, "")}${root ? `/${encodeKeyPath(root)}` : ""}`;
  }
  return imageResourceBaseUrl();
}

/**
 * Configured public image origins, so a page can connect before requesting images.
 * Only enabled backends from the last published snapshot are exposed, since a
 * disabled backend may be an external backup location. Reading this never starts
 * database work, and returns no origins before the registry first loads.
 */
export function publishedPublicImageOrigins() {
  const origins = new Set<string>();
  for (const backend of publishedStorageBackends()) {
    if (!backend.enabled) continue;
    const base = backend.type === "local" ? backend.public_base_url : backend.s3.public_base_url;
    if (base) origins.add(new URL(base).origin);
  }
  return [...origins];
}

export function publicImageUrlForConfig(image: { id: string }, config: StorageConfig, variant: ImageVariant) {
  return imageVariantUrl({ id: image.id, base_url: publicImageBaseUrl(config) }, variant);
}
