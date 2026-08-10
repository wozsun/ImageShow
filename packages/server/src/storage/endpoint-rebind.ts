import { randomBytes, randomUUID } from "node:crypto";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { stagingSessionId } from "../images/imports/staging-keys.ts";
import type { StorageDriver } from "./driver.ts";
import {
  collectStorageKeyListing,
  STORAGE_ADMIN_LIST_MAX_KEYS
} from "./key-listing.ts";

const storageProbePrefix = ".storage-test-";

export type StagingNamespaceSnapshot = {
  keys: Set<string>;
  keysBySession: Map<string, Set<string>>;
};

/** Enumerate `_uploads` once and index every attempt-scoped key by session. */
export async function captureStagingNamespaceSnapshot(
  driver: StorageDriver,
  signal?: AbortSignal
): Promise<StagingNamespaceSnapshot> {
  signal?.throwIfAborted();
  const listing = await collectStorageKeyListing(driver.listKeys("_uploads", {
    signal,
    maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
  }));
  signal?.throwIfAborted();
  if (!listing.complete) {
    throw new Error("Storage staging namespace listing was incomplete");
  }
  const keys = new Set(
    listing.keys
      .filter((key) => !key.startsWith(storageProbePrefix))
  );
  const keysBySession = new Map<string, Set<string>>();
  for (const key of keys) {
    const sessionId = stagingSessionId(key);
    let sessionKeys = keysBySession.get(sessionId);
    if (!sessionKeys) {
      sessionKeys = new Set();
      keysBySession.set(sessionId, sessionKeys);
    }
    sessionKeys.add(key);
  }
  return { keys, keysBySession };
}

function sameKeys(first: ReadonlySet<string>, second: ReadonlySet<string>) {
  return first.size === second.size
    && [...first].every((key) => second.has(key));
}

function stagingSnapshotsMatch(
  current: StagingNamespaceSnapshot,
  candidate: StagingNamespaceSnapshot
) {
  if (!sameKeys(current.keys, candidate.keys)) return false;
  if (current.keysBySession.size !== candidate.keysBySession.size) return false;
  for (const [sessionId, currentKeys] of current.keysBySession) {
    const candidateKeys = candidate.keysBySession.get(sessionId);
    if (!candidateKeys || !sameKeys(currentKeys, candidateKeys)) return false;
  }
  return true;
}

function endpointMismatch(reason: string) {
  return new ApiError(
    409,
    "storage_endpoint_rebind_mismatch",
    "新 Endpoint 无法证明指向当前存储命名空间，已保留原配置",
    { reason }
  );
}

async function removeChallengeObject(driver: StorageDriver, key: string) {
  await driver.remove("_uploads", key);
  if (await driver.exists("_uploads", key)) {
    throw new Error(`Endpoint rebind probe still exists: ${key}`);
  }
}

async function verifyBidirectionalChallenge(
  current: StorageDriver,
  candidate: StorageDriver,
  signal?: AbortSignal
) {
  const probeId = randomUUID();
  const currentKey = `${storageProbePrefix}rebind-${probeId}-current`;
  const candidateKey = `${storageProbePrefix}rebind-${probeId}-candidate`;
  const currentChallenge = randomBytes(32);
  const candidateChallenge = randomBytes(32);
  let verificationError: unknown;

  try {
    signal?.throwIfAborted();
    await current.writeBuffer(
      "_uploads",
      currentKey,
      currentChallenge,
      "application/octet-stream",
      { signal }
    );
    const readThroughCandidate = await candidate.readBuffer(
      "_uploads",
      currentKey,
      { signal }
    );
    if (!readThroughCandidate.equals(currentChallenge)) {
      throw endpointMismatch("candidate_read_mismatch");
    }

    await candidate.writeBuffer(
      "_uploads",
      candidateKey,
      candidateChallenge,
      "application/octet-stream",
      { signal }
    );
    const readThroughCurrent = await current.readBuffer(
      "_uploads",
      candidateKey,
      { signal }
    );
    if (!readThroughCurrent.equals(candidateChallenge)) {
      throw endpointMismatch("current_read_mismatch");
    }
  } catch (error) {
    verificationError = error;
  }

  const cleanupResults = await Promise.allSettled([
    // A remote write can succeed even when its acknowledgement is lost, so
    // always remove both unique probe keys rather than relying on local flags.
    removeChallengeObject(current, currentKey),
    removeChallengeObject(candidate, candidateKey)
  ]);
  const cleanupFailures = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);

  if (cleanupFailures.length) {
    const mismatch = verificationError instanceof ApiError
      && verificationError.code === "storage_endpoint_rebind_mismatch"
      ? verificationError
      : verificationError
        ? endpointMismatch(errorMessage(verificationError))
        : undefined;
    throw new ApiError(
      502,
      "storage_endpoint_rebind_cleanup_failed",
      "Endpoint 重绑定验证对象未能完全清理，已保留原配置",
      {
        failed: cleanupFailures.length,
        ...(mismatch
          ? {
              verification_code: mismatch.code,
              verification_reason: mismatch.details
            }
          : {})
      }
    );
  }
  signal?.throwIfAborted();
  if (verificationError) {
    throw verificationError instanceof ApiError
      && verificationError.code === "storage_endpoint_rebind_mismatch"
      ? verificationError
      : endpointMismatch(errorMessage(verificationError));
  }
}

/** Prove two access endpoints expose the same complete staging namespace. */
export async function verifyStorageEndpointRebind(input: {
  current: StorageDriver;
  candidate: StorageDriver;
  currentStaging: StagingNamespaceSnapshot;
  signal?: AbortSignal;
}) {
  let candidateStaging: StagingNamespaceSnapshot;
  try {
    candidateStaging = await captureStagingNamespaceSnapshot(
      input.candidate,
      input.signal
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    throw endpointMismatch(errorMessage(error));
  }
  input.signal?.throwIfAborted();
  if (!stagingSnapshotsMatch(input.currentStaging, candidateStaging)) {
    throw endpointMismatch("staging_snapshot_mismatch");
  }
  await verifyBidirectionalChallenge(
    input.current,
    input.candidate,
    input.signal
  );
  input.signal?.throwIfAborted();
}
