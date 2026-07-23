import { createHash, type Hash } from "node:crypto";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { logger } from "../core/logger.ts";
import type { StorageConfig } from "./backend-config.ts";
import type { StorageDriver } from "./driver.ts";
import type { StoragePrefix } from "./object-keys.ts";
import { shareStorageNamespace } from "./storage-namespace.ts";

export type StorageEndpoint = {
  config: StorageConfig;
  driver: StorageDriver;
};

export type VerifiedObjectTransfer = {
  created: boolean;
  sharedNamespace: boolean;
};

export type StorageObjectDigest = {
  size: number;
  sha256: string;
  md5?: string;
};

type CandidateObject = {
  prefix: StoragePrefix;
  key: string;
  backend: string;
};

type CandidateCleanup = (object: CandidateObject) => Promise<void>;

type SourceDigestExpectation = {
  size?: number;
  sha256?: string;
  md5?: string;
};

type SourceMismatchError = {
  status: number;
  code: string;
  message: string;
};

async function defaultCleanupLeaseCheck(
  target: StorageConfig,
  prefix: "media" | "thumbs",
  key: string
) {
  const { assertObjectNotPendingCleanup } = await import("./move-cleanup.ts");
  await assertObjectNotPendingCleanup(target, prefix, key);
}

function objectConflict(
  target: StorageEndpoint,
  prefix: StoragePrefix,
  key: string,
  sourceSlug?: string
) {
  return new ApiError(
    409,
    "storage_object_conflict",
    "正式存储对象与候选内容不一致",
    {
      prefix,
      key,
      ...(sourceSlug ? { source: sourceSlug } : {}),
      target: target.config.slug
    }
  );
}

function transferIntegrityFailure(
  target: StorageEndpoint,
  prefix: StoragePrefix,
  key: string,
  sourceSlug?: string
) {
  return new ApiError(
    502,
    "storage_transfer_integrity_failed",
    "存储对象写入后完整性校验失败",
    {
      prefix,
      key,
      ...(sourceSlug ? { source: sourceSlug } : {}),
      target: target.config.slug
    }
  );
}

function updateHashes(hashes: Hash[], chunk: unknown) {
  const bytes = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk as Uint8Array);
  for (const hash of hashes) hash.update(bytes);
  return bytes.byteLength;
}

/** Read an object as a stream and calculate strong integrity metadata. */
async function digestStorageObject(
  endpoint: StorageEndpoint,
  prefix: StoragePrefix,
  key: string,
  options: { includeMd5?: boolean } = {}
): Promise<StorageObjectDigest> {
  const sha256 = createHash("sha256");
  const md5 = options.includeMd5 ? createHash("md5") : undefined;
  const hashes = md5 ? [sha256, md5] : [sha256];
  const opened = await endpoint.driver.openRead(prefix, key);
  let size = 0;
  for await (const chunk of opened.body) {
    size += updateHashes(hashes, chunk);
  }
  return {
    size,
    sha256: sha256.digest("hex"),
    ...(md5 ? { md5: md5.digest("hex") } : {})
  };
}

function sameDigest(left: StorageObjectDigest, right: StorageObjectDigest) {
  return left.size === right.size && left.sha256 === right.sha256;
}

function digestMatchesExpected(
  digest: StorageObjectDigest,
  expected: SourceDigestExpectation
) {
  return (expected.size === undefined || digest.size === expected.size)
    && (!expected.sha256 || digest.sha256 === expected.sha256.toLowerCase())
    && (!expected.md5 || digest.md5 === expected.md5.toLowerCase());
}

async function cleanupCandidate(
  object: CandidateObject,
  cleanup: CandidateCleanup | undefined,
  transferError: unknown
) {
  if (cleanup) {
    try {
      await cleanup(object);
    } catch (cleanupError) {
      logger.error("storage_transfer_candidate_cleanup_failed", {
        backend: object.backend,
        prefix: object.prefix,
        key: object.key,
        transfer_error: errorMessage(transferError),
        cleanup_error: errorMessage(cleanupError)
      });
      throw new AggregateError(
        [transferError, cleanupError],
        "Storage transfer failed and candidate cleanup could not be queued"
      );
    }
    return;
  }
  // A deterministic final key can be adopted by a lock-loss successor. Without
  // an ownership-aware cleanup callback, retaining a harmless orphan is safer
  // than issuing a DELETE that may land after that adoption.
  logger.warn("storage_transfer_candidate_retained", {
    backend: object.backend,
    prefix: object.prefix,
    key: object.key,
    transfer_error: errorMessage(transferError)
  });
}

async function cleanupAttemptedCandidate(
  object: CandidateObject,
  cleanup: CandidateCleanup | undefined,
  transferError: unknown
) {
  // A write/copy acknowledgement can be lost after the object materializes.
  // Queue the deterministic candidate unconditionally; the ownership-aware
  // cleanup handler treats a truly missing object as an idempotent success.
  await cleanupCandidate(object, cleanup, transferError);
}

/**
 * Materialize an already-read object at one target and verify its exact
 * content without reading the target into another full Buffer. Existing
 * objects are never overwritten. A post-write mismatch is an upstream
 * integrity failure (502), not a pre-existing object conflict (409).
 */
export async function ensureVerifiedObjectAtTarget(input: {
  target: StorageEndpoint;
  prefix: StoragePrefix;
  key: string;
  body: Buffer;
  contentType: string;
  sourceSlug?: string;
  cleanupCandidate?: CandidateCleanup;
}): Promise<{ created: boolean }> {
  const {
    target,
    prefix,
    key,
    body,
    contentType,
    sourceSlug,
    cleanupCandidate: candidateCleanup
  } = input;
  const expected: StorageObjectDigest = {
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex")
  };
  if (prefix !== "_uploads") {
    await defaultCleanupLeaseCheck(target.config, prefix, key);
  }
  if (await target.driver.exists(prefix, key)) {
    const existing = await digestStorageObject(target, prefix, key);
    if (!sameDigest(existing, expected)) {
      throw objectConflict(target, prefix, key, sourceSlug);
    }
    return { created: false };
  }

  try {
    await target.driver.writeBuffer(prefix, key, body, contentType);
    const stored = await digestStorageObject(target, prefix, key).catch(() => {
      throw transferIntegrityFailure(target, prefix, key, sourceSlug);
    });
    if (!sameDigest(stored, expected)) {
      throw transferIntegrityFailure(target, prefix, key, sourceSlug);
    }
    return { created: true };
  } catch (error) {
    await cleanupAttemptedCandidate(
      { prefix, key, backend: target.config.slug },
      candidateCleanup,
      error
    );
    throw error;
  }
}

/**
 * Copy within one physical backend using the driver's native copy primitive.
 * Source and target are streamed for hashing, which avoids a second full
 * in-memory copy for S3/WebDAV import commits and category moves.
 */
export async function copyVerifiedObjectWithinStorage(input: {
  storage: StorageEndpoint;
  fromPrefix: StoragePrefix;
  fromKey: string;
  toPrefix: StoragePrefix;
  toKey: string;
  expectedSource?: SourceDigestExpectation;
  sourceMismatch?: SourceMismatchError;
  cleanupCandidate?: CandidateCleanup;
}): Promise<{ created: boolean; sourceDigest: StorageObjectDigest }> {
  const {
    storage,
    fromPrefix,
    fromKey,
    toPrefix,
    toKey,
    expectedSource = {},
    sourceMismatch = {
      status: 502,
      code: "storage_source_integrity_failed",
      message: "源存储对象与记录的完整性信息不一致"
    },
    cleanupCandidate: candidateCleanup
  } = input;
  const sourceDigest = await digestStorageObject(
    storage,
    fromPrefix,
    fromKey,
    { includeMd5: Boolean(expectedSource.md5) }
  );
  if (!digestMatchesExpected(sourceDigest, expectedSource)) {
    throw new ApiError(
      sourceMismatch.status,
      sourceMismatch.code,
      sourceMismatch.message,
      {
        backend: storage.config.slug,
        prefix: fromPrefix,
        key: fromKey
      }
    );
  }

  if (fromPrefix === toPrefix && fromKey === toKey) {
    return { created: false, sourceDigest };
  }
  if (toPrefix !== "_uploads") {
    await defaultCleanupLeaseCheck(storage.config, toPrefix, toKey);
  }
  if (await storage.driver.exists(toPrefix, toKey)) {
    const existing = await digestStorageObject(storage, toPrefix, toKey);
    if (!sameDigest(existing, sourceDigest)) {
      throw objectConflict(storage, toPrefix, toKey, storage.config.slug);
    }
    return { created: false, sourceDigest };
  }

  try {
    await storage.driver.copy(fromPrefix, fromKey, toPrefix, toKey);
    const copied = await digestStorageObject(storage, toPrefix, toKey).catch(() => {
      throw transferIntegrityFailure(
        storage,
        toPrefix,
        toKey,
        storage.config.slug
      );
    });
    if (!sameDigest(copied, sourceDigest)) {
      throw transferIntegrityFailure(
        storage,
        toPrefix,
        toKey,
        storage.config.slug
      );
    }
    return { created: true, sourceDigest };
  } catch (error) {
    await cleanupAttemptedCandidate(
      { prefix: toPrefix, key: toKey, backend: storage.config.slug },
      candidateCleanup,
      error
    );
    throw error;
  }
}

/**
 * Materialize one already-read source object at another backend. Equivalent
 * namespaces are metadata-only switches after the target credentials verify
 * the shared object.
 */
export async function ensureVerifiedObjectAtDestination(input: {
  source: StorageEndpoint;
  target: StorageEndpoint;
  prefix: StoragePrefix;
  key: string;
  body: Buffer;
  contentType: string;
  sourceObjectExists?: boolean;
  cleanupCandidate?: CandidateCleanup;
}): Promise<VerifiedObjectTransfer> {
  const { source, target, prefix, key, body, contentType } = input;
  const sharedNamespace = shareStorageNamespace(source.config, target.config);
  if (sharedNamespace && input.sourceObjectExists !== false) {
    if (prefix !== "_uploads") {
      await defaultCleanupLeaseCheck(
        target.config,
        prefix,
        key
      );
    }
    if (!await target.driver.exists(prefix, key)) {
      throw new ApiError(
        502,
        "storage_shared_object_unavailable",
        "目标后端无法访问共享命名空间中的源对象",
        {
          prefix,
          key,
          source: source.config.slug,
          target: target.config.slug
        }
      );
    }
    const expected: StorageObjectDigest = {
      size: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex")
    };
    const existing = await digestStorageObject(target, prefix, key);
    if (!sameDigest(existing, expected)) {
      throw objectConflict(target, prefix, key, source.config.slug);
    }
    return { created: false, sharedNamespace: true };
  }

  const result = await ensureVerifiedObjectAtTarget({
    target,
    prefix,
    key,
    body,
    contentType,
    sourceSlug: source.config.slug,
    cleanupCandidate: input.cleanupCandidate
  });
  return { ...result, sharedNamespace };
}
