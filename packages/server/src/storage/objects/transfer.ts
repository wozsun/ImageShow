import { createReadStream } from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import type { StorageConfig } from "../backends/config.ts";
import type {
  StorageDriver,
  StorageRequestOptions
} from "../drivers/driver.ts";
import {
  assertObjectNotPendingCleanup,
  setIngestionCandidateGuardConfirmationDeadline
} from "../cleanup/service.ts";
import type { StoragePrefix } from "./keys.ts";
import { shareStorageNamespace } from "./namespace.ts";

export type StorageAccess = {
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

const verifiedStorageTarget = Symbol("verifiedStorageTarget");

/** Reuse only while holding the storage location and image mutation locks. */
export type VerifiedStorageTarget = Readonly<{
  [verifiedStorageTarget]: true;
  storage: StorageAccess;
  prefix: StoragePrefix;
  key: string;
  expected: Readonly<StorageObjectDigest>;
  exists: boolean;
}>;

type CandidateObject = {
  prefix: StoragePrefix;
  key: string;
  backend: string;
};

type CandidateCleanupOptions = Readonly<{
  /**
   * A remote write may still publish after its client reports an uncertain
   * outcome. Keep the durable cleanup lease alive until that request window
   * has elapsed before treating an absent object as terminal.
   */
  confirmAbsentAfter?: Date;
}>;

type CandidateCleanup = (
  object: CandidateObject,
  options?: CandidateCleanupOptions
) => Promise<void>;

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

export type StorageTransferExpectation = Readonly<{
  size: number;
  md5?: string;
}>;

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
  target: StorageAccess,
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
  target: StorageAccess,
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
  storage: StorageAccess,
  prefix: StoragePrefix,
  key: string,
  options: StorageRequestOptions & { includeMd5?: boolean } = {}
): Promise<StorageObjectDigest> {
  const opened = await storage.driver.openRead(prefix, key, undefined, { signal: options.signal });
  return digestReadable(opened.body, Boolean(options.includeMd5));
}

async function digestReadable(body: Readable, includeMd5: boolean): Promise<StorageObjectDigest> {
  const sha256 = createHash("sha256");
  const md5 = includeMd5 ? createHash("md5") : undefined;
  const hashes = md5 ? [sha256, md5] : [sha256];
  let size = 0;
  try {
    for await (const chunk of body) size += updateHashes(hashes, chunk);
    await finished(body, { cleanup: true });
  } finally {
    body.destroy();
    await finished(body, { cleanup: true }).catch(() => undefined);
  }
  return { size, sha256: sha256.digest("hex"), ...(md5 ? { md5: md5.digest("hex") } : {}) };
}

function sameDigest(left: StorageObjectDigest, right: StorageObjectDigest) {
  return left.size === right.size && left.sha256 === right.sha256;
}

async function verifyWrittenObject(input: {
  storage: StorageAccess;
  prefix: StoragePrefix;
  key: string;
  expected: StorageObjectDigest;
  sourceSlug: string;
  signal?: AbortSignal;
}) {
  const { storage, prefix, key, expected, sourceSlug, signal } = input;
  const stored = await digestStorageObject(storage, prefix, key, { signal })
    .catch(() => {
      signal?.throwIfAborted();
      throw transferIntegrityFailure(storage, prefix, key, sourceSlug);
    });
  if (!sameDigest(stored, expected)) {
    throw transferIntegrityFailure(storage, prefix, key, sourceSlug);
  }
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
export async function verifyStorageTarget(input: {
  storage: StorageAccess;
  prefix: StoragePrefix;
  key: string;
  expected: StorageObjectDigest;
  signal?: AbortSignal;
}): Promise<VerifiedStorageTarget> {
  const { storage, prefix, key, signal } = input;
  const expected = { ...input.expected };
  await assertObjectNotPendingCleanup(storage.config, prefix, key);
  const exists = await storage.driver.exists(prefix, key, { signal });
  if (exists) {
    const existing = await digestStorageObject(storage, prefix, key, {
      includeMd5: Boolean(expected.md5),
      signal
    });
    if (!digestMatchesExpected(existing, expected)) {
      throw objectConflict(storage, prefix, key, storage.config.slug);
    }
  }
  return {
    [verifiedStorageTarget]: true,
    storage,
    prefix,
    key,
    expected,
    exists
  };
}

async function cleanupCandidate(
  object: CandidateObject,
  cleanup: CandidateCleanup | undefined,
  transferError: unknown,
  options?: CandidateCleanupOptions
) {
  if (cleanup) {
    try {
      await cleanup(object, options);
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
  transferError: unknown,
  options?: CandidateCleanupOptions
) {
  // A write/copy acknowledgement can be lost after the object materializes.
  // Queue the deterministic candidate unconditionally; the ownership-aware
  // cleanup handler treats a truly missing object as an idempotent success.
  await cleanupCandidate(object, cleanup, transferError, options);
}

/** Publish a verified source using confirmed upload checksums or readback. */
export async function writeVerifiedFileToStorage(input: {
  target: VerifiedStorageTarget;
  sourcePath: string;
  contentType: string;
  onProgress?: (bytes: number) => Promise<void>;
  sourceMismatch?: SourceMismatchError;
  cleanupCandidate?: CandidateCleanup;
  /** Matching pre-write guard owned under the image storage mutation lock. */
  ownedIngestionCandidateGuard?: Readonly<{
    imageId: string;
    token: string;
  }>;
  signal?: AbortSignal;
}): Promise<{ created: boolean; sourceDigest: StorageObjectDigest }> {
  const {
    target,
    sourcePath,
    contentType,
    onProgress,
    sourceMismatch = {
      status: 502,
      code: "storage_source_integrity_failed",
      message: "源存储对象与记录的完整性信息不一致"
    },
    cleanupCandidate: candidateCleanup,
    ownedIngestionCandidateGuard,
    signal
  } = input;
  const { storage, prefix: toPrefix, key: toKey, expected: expectedSource } = target;
  const verifyUpload = storage.config.type === "s3"
    && storage.config.capabilities?.content_md5 === true;
  const sourceDigest = await digestReadable(
    createReadStream(sourcePath, { signal }),
    verifyUpload || Boolean(expectedSource.md5)
  );
  if (!digestMatchesExpected(sourceDigest, expectedSource)) {
    throw new ApiError(
      sourceMismatch.status,
      sourceMismatch.code,
      sourceMismatch.message,
      {
        backend: storage.config.slug
      }
    );
  }

  await assertObjectNotPendingCleanup(storage.config, toPrefix, toKey, {
    ownedIngestionCandidateGuard
  });
  if (target.exists) {
    await onProgress?.(sourceDigest.size);
    return { created: false, sourceDigest };
  }

  const candidate = {
    prefix: toPrefix,
    key: toKey,
    backend: storage.config.slug
  };
  const s3UncertaintyWindowMs = storage.config.type === "s3"
    ? storage.config.s3.task_timeout_seconds * 1_000
    : 0;
  if (s3UncertaintyWindowMs && ownedIngestionCandidateGuard) {
    // Cover the upload, any readback and one remote-settlement window.
    // The error path extends this from the actual rejection time.
    await setIngestionCandidateGuardConfirmationDeadline(
      ownedIngestionCandidateGuard.imageId,
      ownedIngestionCandidateGuard.token,
      new Date(Date.now() + s3UncertaintyWindowMs * (verifyUpload ? 2 : 3)),
      { signal }
    );
    signal?.throwIfAborted();
  }

  try {
    const source = createReadStream(sourcePath, { signal });
    const sourceClosed = finished(source, { cleanup: true }).catch(() => undefined);
    let transferred = 0;
    let lastProgressAt = 0;
    const body = Readable.from((async function* () {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        transferred += (chunk as Buffer).byteLength;
        yield chunk;
        if (onProgress && Date.now() - lastProgressAt >= 500) {
          await onProgress(transferred);
          lastProgressAt = Date.now();
        }
      }
    })());
    const bodyClosed = finished(body, { cleanup: true }).catch(() => undefined);
    try {
      await storage.driver.writeStream(toPrefix, toKey, body, sourceDigest.size, contentType, {
        signal,
        expectedMd5: verifyUpload ? sourceDigest.md5 : undefined,
        atomicCandidateToken: ownedIngestionCandidateGuard?.token
      });
      await onProgress?.(transferred);
    } finally {
      body.destroy();
      source.destroy();
      await Promise.all([bodyClosed, sourceClosed]);
    }
    if (!verifyUpload) {
      await verifyWrittenObject({
        storage,
        prefix: toPrefix,
        key: toKey,
        expected: sourceDigest,
        sourceSlug: storage.config.slug,
        signal
      });
    }
    if (s3UncertaintyWindowMs && ownedIngestionCandidateGuard) {
      await setIngestionCandidateGuardConfirmationDeadline(
        ownedIngestionCandidateGuard.imageId,
        ownedIngestionCandidateGuard.token,
        null,
        { signal }
      );
    }
    return { created: true, sourceDigest };
  } catch (error) {
    const cleanupOptions = s3UncertaintyWindowMs
      ? {
          confirmAbsentAfter: new Date(
            Date.now() + s3UncertaintyWindowMs
          )
        }
      : undefined;
    let transferError = error;
    if (cleanupOptions?.confirmAbsentAfter && ownedIngestionCandidateGuard) {
      try {
        await setIngestionCandidateGuardConfirmationDeadline(
          ownedIngestionCandidateGuard.imageId,
          ownedIngestionCandidateGuard.token,
          cleanupOptions.confirmAbsentAfter
        );
      } catch (guardError) {
        logger.error("storage_transfer_candidate_guard_update_failed", {
          backend: candidate.backend,
          prefix: candidate.prefix,
          key: candidate.key,
          transfer_error: errorMessage(error),
          guard_error: errorMessage(guardError)
        });
        transferError = new AggregateError(
          [error, guardError],
          "Storage transfer failed and candidate guard could not be extended"
        );
      }
    }
    if (candidateCleanup || !ownedIngestionCandidateGuard) {
      await cleanupAttemptedCandidate(
        candidate,
        candidateCleanup,
        transferError,
        cleanupOptions
      );
    }
    throw transferError;
  }
}

function storageSourceObjectMissing(
  source: StorageAccess,
  prefix: StoragePrefix,
  key: string
) {
  return new ApiError(
    404,
    "storage_source_object_not_found",
    "Source storage object not found",
    { backend: source.config.slug, prefix, key }
  );
}

function throwStorageSourceReadError(
  error: unknown,
  source: StorageAccess,
  prefix: StoragePrefix,
  key: string
): never {
  if (error instanceof ApiError && error.code === "storage_object_not_found") {
    throw storageSourceObjectMissing(source, prefix, key);
  }
  throw error;
}

function storageSourceIntegrityFailure(
  source: StorageAccess,
  prefix: StoragePrefix,
  key: string
) {
  return new ApiError(
    502,
    "storage_source_integrity_failed",
    "源存储对象与数据库记录的完整性信息不一致",
    { backend: source.config.slug, prefix, key }
  );
}

function normalizeTransferExpectation(
  source: StorageAccess,
  prefix: StoragePrefix,
  key: string,
  expected: StorageTransferExpectation
) {
  const size = Number(expected.size);
  const md5 = expected.md5?.trim().toLowerCase();
  if (
    !Number.isSafeInteger(size)
    || size < 0
    || (md5 !== undefined && !/^[0-9a-f]{32}$/u.test(md5))
  ) {
    throw storageSourceIntegrityFailure(source, prefix, key);
  }
  return { size, ...(md5 === undefined ? {} : { md5 }) };
}

async function openTransferSource(
  source: StorageAccess,
  prefix: StoragePrefix,
  key: string,
  expectedSize: number,
  signal?: AbortSignal
) {
  let opened;
  try {
    opened = await source.driver.openRead(prefix, key, undefined, { signal });
  } catch (error) {
    throwStorageSourceReadError(error, source, prefix, key);
  }
  const declaredSize = opened.totalSize ?? opened.size;
  if (declaredSize !== undefined && declaredSize !== expectedSize) {
    opened.body.destroy();
    await finished(opened.body, { cleanup: true }).catch(() => undefined);
    throw storageSourceIntegrityFailure(source, prefix, key);
  }
  return opened;
}

async function releaseTransferReadable(body: Readable) {
  if (!body.destroyed && !body.readableEnded) body.destroy();
  await finished(body, { cleanup: true }).catch(() => undefined);
}

async function releaseOpenedTransferSource(
  opened: Awaited<ReturnType<typeof openTransferSource>>,
  wrapper?: Readable
) {
  if (wrapper && wrapper !== opened.body) {
    await releaseTransferReadable(wrapper);
  }
  await releaseTransferReadable(opened.body);
}

async function validateTransferSource(
  source: StorageAccess,
  prefix: StoragePrefix,
  key: string,
  expected: StorageTransferExpectation,
  signal?: AbortSignal
) {
  const opened = await openTransferSource(
    source,
    prefix,
    key,
    expected.size,
    signal
  );
  return validateOpenedTransferSource(
    source,
    prefix,
    key,
    opened,
    expected,
    signal
  );
}

async function validateOpenedTransferSource(
  source: StorageAccess,
  prefix: StoragePrefix,
  key: string,
  opened: Awaited<ReturnType<typeof openTransferSource>>,
  expected: StorageTransferExpectation,
  signal?: AbortSignal
) {
  const md5 = expected.md5 ? createHash("md5") : undefined;
  let size = 0;
  try {
    for await (const chunk of opened.body) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      md5?.update(bytes);
    }
    await finished(opened.body, { cleanup: true });
  } finally {
    await releaseTransferReadable(opened.body);
  }
  signal?.throwIfAborted();
  const actualMd5 = md5?.digest("hex");
  if (
    size !== expected.size
    || (expected.md5 !== undefined && actualMd5 !== expected.md5)
  ) {
    throw storageSourceIntegrityFailure(source, prefix, key);
  }
  return { serverCopyValidator: opened.serverCopyValidator };
}

function verifiedTransferReadable(input: {
  source: StorageAccess;
  prefix: StoragePrefix;
  key: string;
  opened: Awaited<ReturnType<typeof openTransferSource>>;
  expected: StorageTransferExpectation;
  signal?: AbortSignal;
}) {
  const { source, prefix, key, opened, expected, signal } = input;
  let digest: StorageObjectDigest | undefined;
  const body = Readable.from((async function* () {
    const sha256 = createHash("sha256");
    const md5 = expected.md5 ? createHash("md5") : undefined;
    let size = 0;
    try {
      for await (const chunk of opened.body) {
        signal?.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength;
        sha256.update(bytes);
        md5?.update(bytes);
        yield bytes;
      }
      await finished(opened.body, { cleanup: true });
      signal?.throwIfAborted();
      const actualMd5 = md5?.digest("hex");
      if (
        size !== expected.size
        || (expected.md5 !== undefined && actualMd5 !== expected.md5)
      ) {
        throw storageSourceIntegrityFailure(source, prefix, key);
      }
      digest = {
        size,
        sha256: sha256.digest("hex"),
        ...(actualMd5 ? { md5: actualMd5 } : {})
      };
    } finally {
      if (!opened.body.destroyed && !opened.body.readableEnded) {
        opened.body.destroy();
      }
    }
  })());
  return { body, digest: () => digest };
}

/**
 * Transfer one source object without retaining its complete body. Compatible
 * providers may copy server-side after one source verification pass; all
 * other combinations stream the same verified bytes into the destination.
 */
export async function ensureVerifiedObjectAtDestination(input: {
  source: StorageAccess;
  target: StorageAccess;
  prefix: StoragePrefix;
  key: string;
  expected: StorageTransferExpectation;
  contentType: string;
  cleanupCandidate?: CandidateCleanup;
  signal?: AbortSignal;
}): Promise<VerifiedObjectTransfer> {
  const { source, target, prefix, key, contentType, signal } = input;
  const expected = normalizeTransferExpectation(
    source,
    prefix,
    key,
    input.expected
  );
  const sharedNamespace = shareStorageNamespace(source.config, target.config);
  if (sharedNamespace) {
    await assertObjectNotPendingCleanup(
      target.config,
      prefix,
      key
    );
    await validateTransferSource(
      source,
      prefix,
      key,
      expected,
      signal
    );
    if (!await target.driver.exists(prefix, key, { signal })) {
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
    return { created: false };
  }

  await assertObjectNotPendingCleanup(target.config, prefix, key);
  if (await target.driver.exists(prefix, key, { signal })) {
    const sourceDigest = await digestStorageObject(
      source,
      prefix,
      key,
      { includeMd5: Boolean(expected.md5), signal }
    ).catch((error) => throwStorageSourceReadError(
      error,
      source,
      prefix,
      key
    ));
    if (!digestMatchesExpected(sourceDigest, expected)) {
      throw storageSourceIntegrityFailure(source, prefix, key);
    }
    const targetDigest = await digestStorageObject(target, prefix, key, {
      signal
    });
    if (!sameDigest(targetDigest, sourceDigest)) {
      throw objectConflict(target, prefix, key, source.config.slug);
    }
    return { created: false };
  }

  const serverCopySource = source.driver.serverCopySource(
    prefix,
    key,
    expected.size
  );
  const canCopyServerSide = serverCopySource !== undefined
    && target.driver.supportsServerCopySource(serverCopySource);
  const opened = await openTransferSource(
    source,
    prefix,
    key,
    expected.size,
    signal
  );
  const candidate = {
    prefix,
    key,
    backend: target.config.slug
  };
  let attempted = false;
  let streamedBody: Readable | undefined;
  try {
    if (
      canCopyServerSide
      && serverCopySource
      && opened.serverCopyValidator
    ) {
      const sourceValidation = await validateOpenedTransferSource(
        source,
        prefix,
        key,
        opened,
        expected,
        signal
      );
      signal?.throwIfAborted();
      attempted = true;
      await target.driver.copyFromServerSource(
        serverCopySource,
        prefix,
        key,
        {
          signal,
          sourceValidator: sourceValidation.serverCopyValidator
            ?? opened.serverCopyValidator
        }
      );
    } else {
      const verifyUpload = target.config.type === "s3"
        && target.config.capabilities?.content_md5 === true
        && expected.md5 !== undefined;
      const verified = verifiedTransferReadable({
        source,
        prefix,
        key,
        opened,
        expected,
        signal
      });
      streamedBody = verified.body;
      attempted = true;
      await target.driver.writeStream(
        prefix,
        key,
        verified.body,
        expected.size,
        contentType,
        { signal, expectedMd5: verifyUpload ? expected.md5 : undefined }
      );
      const sourceDigest = verified.digest();
      if (!sourceDigest) {
        throw transferIntegrityFailure(
          target,
          prefix,
          key,
          source.config.slug
        );
      }
      if (target.config.type === "s3" && !verifyUpload) {
        await verifyWrittenObject({
          storage: target,
          prefix,
          key,
          expected: sourceDigest,
          sourceSlug: source.config.slug,
          signal
        });
      }
    }
    signal?.throwIfAborted();
    return { created: true };
  } catch (error) {
    await releaseOpenedTransferSource(opened, streamedBody);
    if (attempted) {
      await cleanupAttemptedCandidate(
        candidate,
        input.cleanupCandidate,
        error,
        target.config.type === "s3"
          ? {
              confirmAbsentAfter: new Date(
                Date.now() + target.config.s3.task_timeout_seconds * 1_000
              )
            }
          : undefined
      );
    }
    throw error;
  } finally {
    await releaseOpenedTransferSource(opened, streamedBody);
  }
}
