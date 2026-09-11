import { randomBytes, randomUUID } from "node:crypto";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import type { StorageDriver } from "../drivers/driver.ts";

const storageProbePrefix = ".storage-test-";

function endpointMismatch(reason: string) {
  return new ApiError(
    409,
    "storage_endpoint_rebind_mismatch",
    "新 Endpoint 无法证明指向当前存储命名空间，已保留原配置",
    { reason }
  );
}

async function removeChallengeObject(driver: StorageDriver, key: string) {
  const [result] = await driver.removeObjects([{
    prefix: "full",
    key
  }]);
  if (result?.status === "failed" || result?.status === "unknown") {
    throw new Error(result.error.message);
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
      "full",
      currentKey,
      currentChallenge,
      "application/octet-stream",
      { signal }
    );
    const readThroughCandidate = await candidate.readBuffer(
      "full",
      currentKey,
      { signal }
    );
    if (!readThroughCandidate.equals(currentChallenge)) {
      throw endpointMismatch("candidate_read_mismatch");
    }

    await candidate.writeBuffer(
      "full",
      candidateKey,
      candidateChallenge,
      "application/octet-stream",
      { signal }
    );
    const readThroughCurrent = await current.readBuffer(
      "full",
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

/** Verify both endpoints expose the same writable object namespace. */
export async function verifyStorageEndpointRebind(input: {
  current: StorageDriver;
  candidate: StorageDriver;
  signal?: AbortSignal;
}) {
  await verifyBidirectionalChallenge(input.current, input.candidate, input.signal);
  input.signal?.throwIfAborted();
}
