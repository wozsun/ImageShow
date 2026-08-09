import { ApiError } from "../core/api-error.ts";
import { withAdvisoryLock } from "../core/db.ts";
import type { PoolClient } from "pg";
import { getStorageBackend } from "./backend-registry.ts";
import { withStorageLocationReadLock } from "./maintenance-lock.ts";
import {
  enqueueMoveCleanupJob,
  enqueueThumbnailRepairReceipt as persistThumbnailRepairReceipt,
  listUnresolvedMoveCleanupReferences,
  retryExhaustedMoveCleanupJobs,
  settleThumbnailRepairReceipt as persistSettledThumbnailRepairReceipt,
  type UnresolvedMoveCleanupReference
} from "./move-cleanup-repository.ts";
import {
  markThumbnailRepairPending,
  markThumbnailRepairSettled,
  thumbnailRepairIsPendingInMemory
} from "./thumbnail-repair-state.ts";
import type {
  CapturedMoveCleanupObject,
  MoveCleanupObjectInput
} from "./move-cleanup-types.ts";
import {
  shareStorageNamespace,
  storageNamespaceIdentity,
  storageNamespaceIncludesIdentity
} from "./storage-namespace.ts";

export type {
  CapturedMoveCleanupObject,
  MoveCleanupObjectInput
} from "./move-cleanup-types.ts";
export type ThumbnailRepairCleanupAuthorization = {
  receiptId: string;
  imageId: string;
  object: CapturedMoveCleanupObject & {
    prefix: "thumbs";
    thumbnail_repair: NonNullable<
      CapturedMoveCleanupObject["thumbnail_repair"]
    >;
  };
};

type StorageBackendConfig = Awaited<ReturnType<typeof getStorageBackend>>;

async function cleanupReferenceMatchesTarget(
  reference: UnresolvedMoveCleanupReference,
  target: StorageBackendConfig,
  backends: Map<string, StorageBackendConfig>
) {
  let matchesTarget = reference.backend === target.slug
    || storageNamespaceIncludesIdentity(target, reference.namespace_identity);
  if (!matchesTarget && reference.backend !== target.slug) {
    try {
      let backend = backends.get(reference.backend);
      if (!backend) {
        backend = await getStorageBackend(reference.backend);
        backends.set(reference.backend, backend);
      }
      matchesTarget = storageNamespaceIncludesIdentity(
        backend,
        reference.namespace_identity
      ) && shareStorageNamespace(backend, target);
    } catch {
      // If the lease owner can no longer be resolved, refusing reuse is
      // safer than racing an already-issued remote DELETE.
      matchesTarget = true;
    }
  }
  return matchesTarget;
}

/**
 * An unresolved cleanup row owns deletion of its captured physical object.
 * A successor must not adopt that key until the handler has reached a terminal
 * state, otherwise a non-cancellable remote DELETE could land after adoption.
 */
export async function assertObjectNotPendingCleanup(
  target: Awaited<ReturnType<typeof getStorageBackend>>,
  prefix: "media" | "thumbs",
  key: string,
  authorization?: ThumbnailRepairCleanupAuthorization
) {
  const references = await listUnresolvedMoveCleanupReferences(prefix, key);
  if (!references.length) return;
  const backends = new Map<string, StorageBackendConfig>();

  for (const reference of references) {
    if (
      authorization
      && prefix === "thumbs"
      && reference.job_id === authorization.receiptId
      && reference.target_id === authorization.imageId
      && reference.backend === authorization.object.backend
      && reference.namespace_identity
        === authorization.object.namespace_identity
      && reference.thumbnail_repair_sha256
        === authorization.object.thumbnail_repair.expected_sha256
      && reference.thumbnail_repair_size
        === authorization.object.thumbnail_repair.expected_size
    ) {
      continue;
    }
    if (!await cleanupReferenceMatchesTarget(reference, target, backends)) {
      continue;
    }
    throw new ApiError(
      409,
      "storage_object_cleanup_pending",
      "该存储对象仍由未完成的删除任务占用，请等待清理完成后重试",
      {
        backend: target.slug,
        prefix,
        key,
        cleanup_backend: reference.backend
      }
    );
  }
}

/** Report whether any unresolved write-ahead repair owns this physical key. */
export async function thumbnailObjectHasPendingRepair(
  target: StorageBackendConfig,
  key: string,
  ignoreReceiptId?: string
) {
  const references = await listUnresolvedMoveCleanupReferences("thumbs", key);
  const backends = new Map<string, StorageBackendConfig>();
  for (const reference of references) {
    if (
      reference.job_id === ignoreReceiptId
      || !reference.thumbnail_repair_sha256
      || reference.thumbnail_repair_size === null
      || !await cleanupReferenceMatchesTarget(reference, target, backends)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/** A mutation must not consume or remove bytes owned by a pending repair. */
export async function assertThumbnailRepairNotPending(
  imageId: string,
  target: StorageBackendConfig,
  key: string
) {
  if (await thumbnailObjectHasPendingRepair(target, key)) {
    throw new ApiError(
      409,
      "thumbnail_repair_pending",
      "该图片仍有未完成的缩略图修复，暂不能迁移或永久删除",
      { image_id: imageId, backend: target.slug, key }
    );
  }
}

/**
 * A failed repair can leave bytes at the deterministic final key. Until its
 * durable receipt adopts or removes them, serving must use the original-image
 * fallback instead of treating mere existence as integrity proof.
 */
export function thumbnailRepairIsPending(
  imageId: string,
  key: string
) {
  return thumbnailRepairIsPendingInMemory(imageId, key);
}

const cleanupEnqueueRetryDelaysMs = [0, 50, 150] as const;

export async function captureMoveCleanupObjects(
  objects: readonly MoveCleanupObjectInput[]
): Promise<CapturedMoveCleanupObject[]> {
  const identities = new Map<string, string>();
  const captured: CapturedMoveCleanupObject[] = [];
  const seen = new Set<string>();
  for (const object of objects) {
    const objectIdentity = `${object.backend}:${object.prefix}:${object.key}`;
    if (seen.has(objectIdentity)) continue;
    seen.add(objectIdentity);
    let identity = identities.get(object.backend);
    if (!identity) {
      identity = storageNamespaceIdentity(await getStorageBackend(object.backend));
      identities.set(object.backend, identity);
    }
    captured.push({ ...object, namespace_identity: identity });
  }
  return captured;
}

function canonicalRepairBody(body: Buffer) {
  return body.toString("base64");
}

/**
 * Create the durable write-ahead owner before repair bytes can reach the
 * deterministic thumbnail key. Existing unresolved ownership is accepted only
 * when it describes the exact same physical namespace, digest, size and body.
 */
export async function enqueueThumbnailRepairWriteAhead(
  imageId: string,
  object: MoveCleanupObjectInput & {
    prefix: "thumbs";
    thumbnail_repair: NonNullable<MoveCleanupObjectInput["thumbnail_repair"]>;
  },
  body: Buffer
): Promise<ThumbnailRepairCleanupAuthorization> {
  const [captured] = await captureMoveCleanupObjects([object]);
  if (!captured || captured.prefix !== "thumbs" || !captured.thumbnail_repair) {
    throw new Error("Thumbnail repair receipt could not capture its namespace");
  }
  const bodyBase64 = canonicalRepairBody(body);
  const receipt = await persistThumbnailRepairReceipt(
    imageId,
    captured,
    bodyBase64
  );
  const existingObject = receipt.payload.objects?.[0];
  if (
    receipt.payload.objects?.length !== 1
    || !existingObject
    || existingObject.prefix !== captured.prefix
    || existingObject.key !== captured.key
    || existingObject.backend !== captured.backend
    || existingObject.namespace_identity !== captured.namespace_identity
    || existingObject.thumbnail_repair?.expected_sha256
      !== captured.thumbnail_repair.expected_sha256
    || existingObject.thumbnail_repair?.expected_size
      !== captured.thumbnail_repair.expected_size
    || receipt.payload.thumbnail_repair_body_base64 !== bodyBase64
  ) {
    throw new ApiError(
      409,
      "thumbnail_repair_already_pending",
      "该缩略图已有内容不同的修复任务，请等待现有任务收口"
    );
  }
  markThumbnailRepairPending(imageId, captured.key);
  return {
    receiptId: receipt.id,
    imageId,
    object: captured as ThumbnailRepairCleanupAuthorization["object"]
  };
}

/**
 * Foreground repair completion is durable before its caller can enqueue a
 * source cleanup or permanently delete the image under the same image lock.
 */
export async function settleThumbnailRepairWriteAhead(
  authorization: ThumbnailRepairCleanupAuthorization,
  body: Buffer
) {
  const bodyBase64 = canonicalRepairBody(body);
  const settled = await persistSettledThumbnailRepairReceipt(
    authorization.receiptId,
    authorization.imageId,
    authorization.object,
    bodyBase64
  );
  if (!settled) {
    throw new ApiError(
      409,
      "thumbnail_repair_receipt_changed",
      "缩略图修复回执在完成前发生变化，已保留任务供 Worker 收敛",
      { image_id: authorization.imageId, receipt_id: authorization.receiptId }
    );
  }
  markThumbnailRepairSettled(
    authorization.imageId,
    authorization.object.key
  );
}

export function enqueueCapturedObjectsForCleanup(
  imageId: string,
  objects: readonly CapturedMoveCleanupObject[],
  reason: string,
  client?: PoolClient
) {
  if (client) {
    return enqueueMoveCleanupJob(imageId, objects, reason, client);
  }
  return withStorageLocationReadLock(async (signal) => {
    signal.throwIfAborted();
    await enqueueMoveCleanupWithRetry(
      imageId,
      objects,
      reason,
      signal
    );
    signal.throwIfAborted();
  });
}

/**
 * Persist already-captured physical ownership without borrowing another
 * storage-location lock. Callers must capture the namespace before the risky
 * write; this remains safe after the original lock signal is lost because the
 * receipt never follows a mutable slug to a different physical location.
 */
export async function enqueueCapturedObjectsForCleanupDetached(
  imageId: string,
  objects: readonly CapturedMoveCleanupObject[],
  reason: string
) {
  if (!objects.length) return;
  const signal = new AbortController().signal;
  await enqueueMoveCleanupWithRetry(imageId, objects, reason, signal);
}

/**
 * Queue cleanup against the physical namespace observed at enqueue time. The
 * deterministic key still deduplicates active work; terminal history can be
 * reset by the repository when the same object needs cleanup again.
 */
function wait(delayMs: number) {
  return delayMs > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    : Promise.resolve();
}

async function enqueueMoveCleanupWithRetry(
  imageId: string,
  objects: readonly CapturedMoveCleanupObject[],
  reason: string,
  signal: AbortSignal
) {
  let lastError: unknown;
  for (const delayMs of cleanupEnqueueRetryDelaysMs) {
    signal.throwIfAborted();
    await wait(delayMs);
    signal.throwIfAborted();
    try {
      await enqueueMoveCleanupJob(imageId, objects, reason);
      signal.throwIfAborted();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Defer deletion to the move.cleanup handler. The handler reacquires the image
 * lock and re-reads PostgreSQL immediately before removal, so candidates that
 * a lock-loss successor adopts are retained.
 */
export async function enqueueObjectsForCleanup(
  imageId: string,
  objects: readonly MoveCleanupObjectInput[],
  reason: string
) {
  if (!objects.length) return;
  await withStorageLocationReadLock(async (signal) => {
    signal.throwIfAborted();
    const captured = await captureMoveCleanupObjects(objects);
    signal.throwIfAborted();
    await enqueueMoveCleanupWithRetry(imageId, captured, reason, signal);
    signal.throwIfAborted();
  });
}

export async function retryStorageBackendCleanup(slug: string) {
  await withAdvisoryLock(
    `imageshow:storage-backend:${slug}`,
    async (signal) => {
      signal.throwIfAborted();
      await getStorageBackend(slug);
      signal.throwIfAborted();
      await retryExhaustedMoveCleanupJobs(slug);
      signal.throwIfAborted();
    }
  );
}
