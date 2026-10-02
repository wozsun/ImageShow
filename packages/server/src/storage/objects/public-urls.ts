import { imageVariantUrl, type ImageVariant } from "@imageshow/shared/browser";
import { imageResourceBaseUrl } from "../../config/site-host.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { assertLocalPublicUrlDomain, type StorageConfig } from "../backends/config.ts";
import { getStorageBackend, type StorageRegistryAccess } from "../backends/registry.ts";
import { storageS3ObjectName, type ReadablePrefix } from "./keys.ts";

function encodeKeyPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function directStorageObjectUrl(config: StorageConfig, prefix: ReadablePrefix, key: string) {
  if (config.type === "local") {
    if (!config.public_base_url) return "";
    assertLocalPublicUrlDomain(config.public_base_url, getRuntimeConfig().site.domain);
    return `${config.public_base_url.replace(/\/+$/, "")}/${prefix}/${encodeKeyPath(key)}`;
  }
  if (!config.s3.public_base_url) return "";
  return `${config.s3.public_base_url.replace(/\/+$/, "")}/${encodeKeyPath(storageS3ObjectName(config, prefix, key))}`;
}

export function publicImageBaseUrl(config: StorageConfig) {
  if (config.type === "local" && config.public_base_url) {
    assertLocalPublicUrlDomain(config.public_base_url, getRuntimeConfig().site.domain);
    return config.public_base_url.replace(/\/+$/, "");
  }
  if (config.type === "s3" && config.s3.public_base_url) {
    const root = (config.s3.root_path ?? "").replace(/^\/+|\/+$/g, "");
    return `${config.s3.public_base_url.replace(/\/+$/, "")}${root ? `/${encodeKeyPath(root)}` : ""}`;
  }
  return imageResourceBaseUrl();
}

export function publicImageUrlForConfig(image: { id: string }, config: StorageConfig, variant: ImageVariant) {
  return imageVariantUrl({ id: image.id, base_url: publicImageBaseUrl(config) }, variant);
}

export async function publicImageUrl(image: { id: string }, slug: string, variant: ImageVariant, access: StorageRegistryAccess) {
  return publicImageUrlForConfig(image, await getStorageBackend(slug, access), variant);
}
