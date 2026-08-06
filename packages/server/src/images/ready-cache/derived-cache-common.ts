import {
  READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY,
  READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
  READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY,
  READY_IMAGE_FILTER_KEY_PREFIX,
  READY_IMAGE_STATS_RESULT_KEY_PREFIX,
  assertReadyImageDerivedCacheKey,
  readyImageAttributeIndexMetaKey,
  readyImageAttributeIndexSpec,
  readyImageFilterMetaKeyForFilterKey
} from "./keys.ts";
import {
  READY_IMAGE_DERIVED_CACHE_POLICY,
  type ReadyImageDerivedResultKind
} from "./derived-cache-policy.ts";
import { markReadyImageCacheLastUpdated } from "./last-updated.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";

const signaturePattern = /^[0-9a-f]{64}$/u;
let lastAccessScore = 0;

export type DerivedResultDescriptor = {
  key: string;
  kind: ReadyImageDerivedResultKind;
  metaKey: string | null;
  signature: string | null;
};

export const derivedRegistryKeys = [
  READY_IMAGE_DERIVED_REGISTRY_LRU_KEY,
  READY_IMAGE_DERIVED_REGISTRY_COUNTS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_BYTES_KEY,
  READY_IMAGE_DERIVED_REGISTRY_KINDS_KEY,
  READY_IMAGE_DERIVED_REGISTRY_SIGNATURES_KEY
];

export async function recordDerivedCacheModification() {
  try {
    await markReadyImageCacheLastUpdated();
  } catch (error) {
    recordReadyImageCacheError(
      "derived",
      "last_updated_write_failed",
      error
    );
  }
}

export function nonNegativeInteger(raw: unknown) {
  const value = String(raw ?? "");
  if (!/^\d+$/u.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

export function nextDerivedAccessScore() {
  lastAccessScore = Math.max(Date.now(), lastAccessScore + 1);
  return lastAccessScore;
}

function digestSuffix(key: string, prefix: string) {
  const signature = key.slice(prefix.length);
  return signaturePattern.test(signature) ? signature : null;
}

export function describeReadyImageDerivedResult(
  key: string
): DerivedResultDescriptor | null {
  if (readyImageAttributeIndexSpec(key)) {
    return {
      key,
      kind: "attribute",
      metaKey: readyImageAttributeIndexMetaKey(key),
      signature: null
    };
  }
  if (key.startsWith(READY_IMAGE_FILTER_KEY_PREFIX)) {
    const signature = digestSuffix(key, READY_IMAGE_FILTER_KEY_PREFIX);
    return signature ? {
      key,
      kind: "filter",
      metaKey: readyImageFilterMetaKeyForFilterKey(key),
      signature
    } : null;
  }
  if (key.startsWith(READY_IMAGE_STATS_RESULT_KEY_PREFIX)) {
    const signature = digestSuffix(key, READY_IMAGE_STATS_RESULT_KEY_PREFIX);
    return signature ? {
      key,
      kind: "stats-result",
      metaKey: null,
      signature
    } : null;
  }
  return null;
}

export function assertReadyImageDerivedResult(
  key: string,
  kind?: ReadyImageDerivedResultKind
) {
  assertReadyImageDerivedCacheKey(key);
  const descriptor = describeReadyImageDerivedResult(key);
  if (!descriptor || (kind && descriptor.kind !== kind)) {
    throw new Error(`Invalid ready-image derived ${kind ?? "result"} key: ${key}`);
  }
  return descriptor;
}

export function readyImageDerivedMembershipLimit(itemCount: number) {
  const multiplied = itemCount
    * READY_IMAGE_DERIVED_CACHE_POLICY.totalMemberMultiplier;
  if (!Number.isSafeInteger(multiplied)) {
    throw new Error(
      "Ready-image derived membership limit is outside the safe range"
    );
  }
  return Math.max(
    READY_IMAGE_DERIVED_CACHE_POLICY.minimumTotalMembers,
    multiplied
  );
}
