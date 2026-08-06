import {
  READY_IMAGE_DERIVED_CACHE_POLICY,
  type ReadyImageDerivedResultKind
} from "./derived-cache-policy.ts";

type ReadyImageDerivedOccupancyEntry = {
  kind: ReadyImageDerivedResultKind;
  count: number;
  bytes: number | null;
  expiresAt: number;
};

const entries = new Map<string, ReadyImageDerivedOccupancyEntry>();
let occupancyKnown = false;
let registryMemoryBytes: number | null = null;

function expiresAt() {
  return Date.now() + READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds * 1_000;
}

function pruneExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  if (!entries.size && occupancyKnown) registryMemoryBytes = 0;
}

export function rememberReadyImageDerivedOccupancy(options: {
  key: string;
  kind: ReadyImageDerivedResultKind;
  count: number;
  bytes?: number | null;
}) {
  const existing = entries.get(options.key);
  entries.set(options.key, {
    kind: options.kind,
    count: options.count,
    bytes: options.bytes === undefined
      ? existing?.bytes ?? null
      : options.bytes,
    expiresAt: expiresAt()
  });
}

export function forgetReadyImageDerivedOccupancy(keys: Iterable<string>) {
  for (const key of keys) entries.delete(key);
}

export function setReadyImageDerivedRegistryMemory(bytes: number | null) {
  registryMemoryBytes = bytes;
}

export function resetReadyImageDerivedOccupancyMirror() {
  entries.clear();
  occupancyKnown = true;
  registryMemoryBytes = 0;
}

export function invalidateReadyImageDerivedOccupancyMirror() {
  entries.clear();
  occupancyKnown = false;
  registryMemoryBytes = null;
}

export async function readReadyImageDerivedOccupancy() {
  pruneExpiredEntries();
  if (!occupancyKnown) {
    return {
      keyCount: null,
      memberCount: null,
      memoryBytes: null
    };
  }
  let keyCount = entries.size ? 5 : 0;
  let memberCount = 0;
  let memoryBytes = registryMemoryBytes ?? 0;
  let memoryKnown = registryMemoryBytes !== null;
  for (const entry of entries.values()) {
    keyCount += entry.kind === "stats-result"
      ? 1
      : 1 + (entry.count > 0 ? 1 : 0);
    memberCount += entry.count;
    if (entry.bytes === null) memoryKnown = false;
    else memoryBytes += entry.bytes;
    if (
      !Number.isSafeInteger(keyCount)
      || !Number.isSafeInteger(memberCount)
      || !Number.isSafeInteger(memoryBytes)
    ) {
      throw new Error("Ready-image derived occupancy metadata is invalid");
    }
  }
  return {
    keyCount,
    memberCount,
    memoryBytes: memoryKnown ? memoryBytes : null
  };
}
