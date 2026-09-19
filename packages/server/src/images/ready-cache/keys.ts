import { hash } from "node:crypto";
import {
  brightnesses,
  devices,
  slugMaxLength,
  slugPattern,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";

const READY_IMAGE_CACHE_NAMESPACE = "imageshow:cache:images";
export const READY_IMAGE_CACHE_PREFIX = `${READY_IMAGE_CACHE_NAMESPACE}:`;
export const READY_IMAGE_DERIVED_PREFIX = `${READY_IMAGE_CACHE_PREFIX}derived:`;
export const READY_IMAGE_META_KEY = `${READY_IMAGE_CACHE_PREFIX}meta`;
export const READY_IMAGE_ITEMS_KEY = `${READY_IMAGE_CACHE_PREFIX}items`;
export const READY_IMAGE_STATS_KEY = `${READY_IMAGE_CACHE_PREFIX}stats`;
export const READY_IMAGE_INTEGRITY_KEY = `${READY_IMAGE_CACHE_PREFIX}integrity`;
export const READY_IMAGE_ALL_INDEX_KEY = `${READY_IMAGE_CACHE_PREFIX}index:all`;
export const READY_IMAGE_ID_SUFFIX_LOOKUP_KEY = `${READY_IMAGE_CACHE_PREFIX}lookup:id-suffix`;
export const READY_IMAGE_EMPTY_CORE_KEYS = Object.freeze([
  READY_IMAGE_META_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_INTEGRITY_KEY
]);
export const READY_IMAGE_CORE_KEYS = Object.freeze([
  ...READY_IMAGE_EMPTY_CORE_KEYS,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY
]);
export const READY_IMAGE_DERIVED_INDEX_PREFIX = `${READY_IMAGE_DERIVED_PREFIX}index:`;
export const READY_IMAGE_DERIVED_INDEX_META_PREFIX = `${READY_IMAGE_DERIVED_PREFIX}index-meta:`;
export const READY_IMAGE_DERIVED_REGISTRY_LRU_KEY = `${READY_IMAGE_DERIVED_PREFIX}registry:lru`;
export const READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY = `${READY_IMAGE_DERIVED_PREFIX}registry:counts`;
export const READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY = `${READY_IMAGE_DERIVED_PREFIX}registry:kinds`;
export const READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY = `${READY_IMAGE_DERIVED_PREFIX}registry:signatures`;

export const READY_IMAGE_FILTER_KEY_PREFIX = `${READY_IMAGE_DERIVED_PREFIX}filter:`;
export const READY_IMAGE_FILTER_META_KEY_PREFIX = `${READY_IMAGE_DERIVED_PREFIX}filter-meta:`;
export const READY_IMAGE_STATS_RESULT_KEY_PREFIX = `${READY_IMAGE_DERIVED_PREFIX}stats-result:`;
const READY_IMAGE_FILTER_TEMP_KEY_PREFIX = `${READY_IMAGE_DERIVED_PREFIX}temp:filter:`;
const READY_IMAGE_INDEX_TEMP_KEY_PREFIX = `${READY_IMAGE_DERIVED_PREFIX}temp:index:`;
export const READY_IMAGE_ATTRIBUTE_SLUG_MAX_LENGTH = slugMaxLength;
export const READY_IMAGE_FIXED_ATTRIBUTE_SUFFIXES = Object.freeze(
  devices.flatMap((device) => [
    `device:${device}`,
    ...brightnesses.map((brightness) => `axis:${device}:${brightness}`)
  ])
);
export const READY_IMAGE_NAMED_ATTRIBUTE_KINDS = [
  "theme",
  "tag",
  "author"
] as const;

export type ReadyImageAttributeIndexSpec =
  | { kind: "axis"; device: Device; brightness: Brightness }
  | { kind: "device"; value: Device }
  | { kind: "theme" | "tag" | "author"; value: string };

export function readyImageAttributeIndexKey(
  spec: ReadyImageAttributeIndexSpec
) {
  if (spec.kind === "axis") {
    if (
      !devices.includes(spec.device)
      || !brightnesses.includes(spec.brightness)
    ) {
      throw new Error("Invalid ready-image attribute axis");
    }
    return `${READY_IMAGE_DERIVED_INDEX_PREFIX}axis:${spec.device}:${spec.brightness}`;
  }
  if (spec.kind === "device") {
    if (!devices.includes(spec.value)) {
      throw new Error("Invalid ready-image device attribute");
    }
    return `${READY_IMAGE_DERIVED_INDEX_PREFIX}device:${spec.value}`;
  }
  if (
    !READY_IMAGE_NAMED_ATTRIBUTE_KINDS.includes(spec.kind)
    || spec.value.length > READY_IMAGE_ATTRIBUTE_SLUG_MAX_LENGTH
    || !slugPattern.test(spec.value)
  ) {
    throw new Error("Invalid ready-image named attribute");
  }
  return `${READY_IMAGE_DERIVED_INDEX_PREFIX}${spec.kind}:${spec.value}`;
}

export function readyImageAttributeIndexSpec(
  key: string
): ReadyImageAttributeIndexSpec | null {
  if (!key.startsWith(READY_IMAGE_DERIVED_INDEX_PREFIX)) return null;
  const parts = key.slice(READY_IMAGE_DERIVED_INDEX_PREFIX.length).split(":");
  if (
    parts.length === 3
    && READY_IMAGE_FIXED_ATTRIBUTE_SUFFIXES.includes(
      parts.join(":")
    )
  ) {
    return {
      kind: "axis",
      device: parts[1] as "pc" | "mb",
      brightness: parts[2] as "dark" | "light"
    };
  }
  const [kind, value] = parts;
  if (parts.length === 2 && kind === "device" && devices.includes(value as Device)) {
    return { kind, value: value as Device };
  }
  if (
    parts.length === 2
    && READY_IMAGE_NAMED_ATTRIBUTE_KINDS.includes(
      kind as typeof READY_IMAGE_NAMED_ATTRIBUTE_KINDS[number]
    )
    && value
    && value.length <= READY_IMAGE_ATTRIBUTE_SLUG_MAX_LENGTH
    && slugPattern.test(value)
  ) {
    return {
      kind: kind as typeof READY_IMAGE_NAMED_ATTRIBUTE_KINDS[number],
      value
    };
  }
  return null;
}

export function readyImageAttributeIndexMetaKey(indexKey: string) {
  if (!indexKey.startsWith(READY_IMAGE_DERIVED_INDEX_PREFIX)) {
    throw new Error(`Invalid ready-image attribute index key: ${indexKey}`);
  }
  return `${READY_IMAGE_DERIVED_INDEX_META_PREFIX}${indexKey.slice(
    READY_IMAGE_DERIVED_INDEX_PREFIX.length
  )}`;
}

export function readyImageAttributeIndexTemporaryKey(token: string) {
  if (!/^[0-9a-f]{32}$/u.test(token)) {
    throw new Error("Invalid ready-image attribute index temporary owner");
  }
  return `${READY_IMAGE_INDEX_TEMP_KEY_PREFIX}${token}`;
}

function filterDigest(signature: string) {
  return hash("sha256", signature, "hex");
}

export function readyImageFilterKey(signature: string) {
  return `${READY_IMAGE_FILTER_KEY_PREFIX}${filterDigest(signature)}`;
}

export function readyImageFilterMetaKey(signature: string) {
  return `${READY_IMAGE_FILTER_META_KEY_PREFIX}${filterDigest(signature)}`;
}

export function readyImageFilterMetaKeyForFilterKey(key: string) {
  if (!key.startsWith(READY_IMAGE_FILTER_KEY_PREFIX)) {
    throw new Error(`Invalid ready-image filter key: ${key}`);
  }
  return `${READY_IMAGE_FILTER_META_KEY_PREFIX}${key.slice(
    READY_IMAGE_FILTER_KEY_PREFIX.length
  )}`;
}

export function readyImageStatsResultKey(signature: string) {
  return `${READY_IMAGE_STATS_RESULT_KEY_PREFIX}${filterDigest(signature)}`;
}

export function readyImageFilterTemporaryKey(
  token: string,
  sequence: number
) {
  if (
    !/^[0-9a-f]{32}$/u.test(token)
    || !Number.isSafeInteger(sequence)
    || sequence < 0
  ) {
    throw new Error("Invalid ready-image filter temporary key owner");
  }
  return `${READY_IMAGE_FILTER_TEMP_KEY_PREFIX}${token}:${sequence}`;
}

export function readyImageFilterTemporaryKeyBelongsTo(
  key: string,
  token: string
) {
  if (!/^[0-9a-f]{32}$/u.test(token)) return false;
  const prefix = `${READY_IMAGE_FILTER_TEMP_KEY_PREFIX}${token}:`;
  const sequence = key.slice(prefix.length);
  return key.startsWith(prefix) && /^\d+$/u.test(sequence);
}

function isReadyImageCacheKey(key: string) {
  return key.startsWith(READY_IMAGE_CACHE_PREFIX);
}

export function assertReadyImageCacheKey(key: string) {
  if (!isReadyImageCacheKey(key)) {
    throw new Error(`Refusing to operate on non-image-cache key: ${key}`);
  }
  return key;
}

export function assertReadyImageDerivedCacheKey(key: string) {
  if (!key.startsWith(READY_IMAGE_DERIVED_PREFIX)) {
    throw new Error(`Refusing to operate on non-derived image-cache key: ${key}`);
  }
  return key;
}
