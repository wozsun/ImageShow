import { normalize, resolve } from "node:path";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import type { StorageConfig } from "../backends/config.ts";

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

/**
 * Return an opaque identity for the physical namespace that owns every
 * `full/`, transitional `media/`, `thumbs/` and `_uploads/` key. Credentials, public URLs,
 * timeouts and display settings intentionally do not participate.
 */
export function configuredStorageNamespaceIdentity(config: StorageConfig) {
  if (config.type === "s3") {
    return JSON.stringify([
      "s3",
      canonicalHttpsEndpoint(config.s3.endpoint),
      config.s3.bucket.trim(),
      normalizedRootPath(config.s3.root_path)
    ]);
  }
  const localRoot = normalize(resolve(runtimePaths.storageDirectory));
  return JSON.stringify([
    "local",
    process.platform === "win32" ? localRoot.toLowerCase() : localRoot
  ]);
}

/**
 * Compare physical layout while treating an S3 endpoint as an access address.
 */
export function storageNamespaceLayoutIdentity(config: StorageConfig) {
  if (config.type === "s3") {
    return JSON.stringify([
      "s3",
      config.s3.bucket.trim(),
      normalizedRootPath(config.s3.root_path)
    ]);
  }
  return configuredStorageNamespaceIdentity(config);
}

export function storageNamespaceIdentities(config: StorageConfig) {
  return new Set([
    configuredStorageNamespaceIdentity(config),
    ...(config.namespace_identities ?? [])
      .map((identity) => identity.trim())
      .filter(Boolean)
  ]);
}

/** Capture the access identity that owns a cleanup object at this moment. */
export function storageNamespaceIdentity(config: StorageConfig) {
  return configuredStorageNamespaceIdentity(config);
}

export function storageNamespaceIncludesIdentity(
  config: StorageConfig,
  identity: string
) {
  return storageNamespaceIdentities(config).has(identity);
}

export function shareStorageNamespace(source: StorageConfig, target: StorageConfig) {
  const sourceIdentities = storageNamespaceIdentities(source);
  return [...storageNamespaceIdentities(target)]
    .some((identity) => sourceIdentities.has(identity));
}

/**
 * Build transitive physical-namespace groups. Historical identities can join
 * backends whose current access endpoints differ, so direct current-identity
 * grouping is not sufficient for whole-namespace maintenance.
 */
export function groupStorageNamespaces<T extends StorageConfig>(
  configs: readonly T[]
) {
  const groups: T[][] = [];
  for (const config of configs) {
    const matches = groups.flatMap((group, index) => (
      group.some((candidate) => shareStorageNamespace(candidate, config))
        ? [index]
        : []
    ));
    if (!matches.length) {
      groups.push([config]);
      continue;
    }
    const merged = matches.flatMap((index) => groups[index] ?? []);
    merged.push(config);
    for (const index of matches.toReversed()) groups.splice(index, 1);
    groups.push(merged);
  }
  return groups;
}

/** Stable only while every current and historical identity in a group agrees. */
export function storageNamespaceGroupIdentity(
  configs: readonly StorageConfig[]
) {
  return JSON.stringify([
    ...new Set(configs.flatMap((config) => [
      ...storageNamespaceIdentities(config)
    ]))
  ].toSorted());
}
