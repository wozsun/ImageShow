import { createHash, type Hash } from "node:crypto";
import { finished } from "node:stream/promises";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import type { StorageConfig } from "../backends/config.ts";
import type {
  StorageDriver,
  StorageRequestOptions
} from "../drivers/driver.ts";
import { assertObjectNotPendingCleanup } from "../cleanup/service.ts";
import type { StoragePrefix } from "./keys.ts";
import { shareStorageNamespace } from "./namespace.ts";

export type StorageEndpoint = {
  config: StorageConfig;
  driver: StorageDriver;
};

export type VerifiedObjectTransfer = {
  created: boolean;
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

export function missingThumbnailSourceError({
  imageId,
  backend,
  key
}: {
  imageId: string;
  backend: string;
  key: string;
}) {
  return new ApiError(
    409,
    "storage_thumbnail_missing",
    "图片当前位置的缩略图不存在，请先在检查页运行“存储维护”",
    { image_id: imageId, backend, prefix: "thumbs", key }
  );
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
export async function digestStorageObject(
  endpoint: StorageEndpoint,
  prefix: StoragePrefix,
  key: string,
  options: StorageRequestOptions & { includeMd5?: boolean } = {}
): Promise<StorageObjectDigest> {
  const sha256 = createHash("sha256");
  const md5 = options.includeMd5 ? createHash("md5") : undefined;
  const hashes = md5 ? [sha256, md5] : [sha256];
  const opened = await endpoint.driver.openRead(
    prefix,
    key,
    undefined,
    { signal: options.signal }
  );
  let size = 0;
  for await (const chunk of opened.body) {
    size += updateHashes(hashes, chunk);
  }
  // Async iteration completes on `end`, while FileHandle-backed streams may
  // close their descriptor on the following turn. Wait for the complete
  // stream lifecycle so an immediately-following move cleanup can unlink the
  // local source on Windows as reliably as it can on Linux.
  await finished(opened.body, { cleanup: true });
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

/**
 * Prove that a formal target can be owned before registering a cleanup guard.
 * An absent object is writable; an existing object is adoptable only when its
 * strong digest already matches the frozen commit manifest.
 */
export async function assertStorageTargetAvailable(input: {
  storage: StorageEndpoint;
  prefix: "media" | "thumbs";
  key: string;
  expected: SourceDigestExpectation;
  signal?: AbortSignal;
}) {
  const { storage, prefix, key, expected, signal } = input;
  await assertObjectNotPendingCleanup(storage.config, prefix, key);
  if (!await storage.driver.exists(prefix, key, { signal })) return;
  const existing = await digestStorageObject(storage, prefix, key, {
    includeMd5: Boolean(expected.md5),
    signal
  });
  if (!digestMatchesExpected(existing, expected)) {
    throw objectConflict(storage, prefix, key, storage.config.slug);
  }
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
async function ensureVerifiedObjectAtTarget(input: {
  target: StorageEndpoint;
  prefix: StoragePrefix;
  key: string;
  body: Buffer;
  contentType: string;
  sourceSlug?: string;
  cleanupCandidate?: CandidateCleanup;
  signal?: AbortSignal;
}): Promise<{ created: boolean }> {
  const {
    target,
    prefix,
    key,
    body,
    contentType,
    sourceSlug,
    cleanupCandidate: candidateCleanup,
    signal
  } = input;
  const expected: StorageObjectDigest = {
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex")
  };
  if (prefix !== "_uploads") {
    await assertObjectNotPendingCleanup(target.config, prefix, key);
  }
  if (await target.driver.exists(prefix, key, { signal })) {
    const existing = await digestStorageObject(target, prefix, key, { signal });
    if (!sameDigest(existing, expected)) {
      throw objectConflict(target, prefix, key, sourceSlug);
    }
    return { created: false };
  }

  try {
    await target.driver.writeBuffer(
      prefix,
      key,
      body,
      contentType,
      { signal }
    );
    const stored = await digestStorageObject(
      target,
      prefix,
      key,
      { signal }
    ).catch(() => {
      signal?.throwIfAborted();
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
 * in-memory copy for S3 Ingestion commits and category moves.
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
  /** Matching pre-copy guard owned under the image storage mutation lock. */
  ownedIngestionCandidateGuard?: Readonly<{
    imageId: string;
    token: string;
  }>;
  signal?: AbortSignal;
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
    cleanupCandidate: candidateCleanup,
    ownedIngestionCandidateGuard,
    signal
  } = input;
  const sourceDigest = await digestStorageObject(
    storage,
    fromPrefix,
    fromKey,
    { includeMd5: Boolean(expectedSource.md5), signal }
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
    await assertObjectNotPendingCleanup(storage.config, toPrefix, toKey, {
      ownedIngestionCandidateGuard
    });
  }
  if (await storage.driver.exists(toPrefix, toKey, { signal })) {
    const existing = await digestStorageObject(
      storage,
      toPrefix,
      toKey,
      { signal }
    );
    if (!sameDigest(existing, sourceDigest)) {
      throw objectConflict(storage, toPrefix, toKey, storage.config.slug);
    }
    return { created: false, sourceDigest };
  }

  try {
    await storage.driver.copy(
      fromPrefix,
      fromKey,
      toPrefix,
      toKey,
      {
        signal,
        atomicCandidateToken: ownedIngestionCandidateGuard?.token
      }
    );
    const copied = await digestStorageObject(
      storage,
      toPrefix,
      toKey,
      { signal }
    ).catch(() => {
      signal?.throwIfAborted();
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
  cleanupCandidate?: CandidateCleanup;
  signal?: AbortSignal;
}): Promise<VerifiedObjectTransfer> {
  const { source, target, prefix, key, body, contentType } = input;
  const sharedNamespace = shareStorageNamespace(source.config, target.config);
  if (sharedNamespace) {
    if (prefix !== "_uploads") {
      await assertObjectNotPendingCleanup(
        target.config,
        prefix,
        key
      );
    }
    if (!await target.driver.exists(prefix, key, { signal: input.signal })) {
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
    const existing = await digestStorageObject(
      target,
      prefix,
      key,
      { signal: input.signal }
    );
    if (!sameDigest(existing, expected)) {
      throw objectConflict(target, prefix, key, source.config.slug);
    }
    return { created: false };
  }

  return ensureVerifiedObjectAtTarget({
    target,
    prefix,
    key,
    body,
    contentType,
    sourceSlug: source.config.slug,
    cleanupCandidate: input.cleanupCandidate,
    signal: input.signal
  });
}
