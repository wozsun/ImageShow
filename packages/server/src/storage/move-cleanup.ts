import { ApiError } from "../core/api-error.ts";
import { withAdvisoryLock } from "../core/db.ts";
import type { PoolClient } from "pg";
import { getStorageBackend } from "./backend-registry.ts";
import { withStorageLocationReadLock } from "./maintenance-lock.ts";
import {
  enqueueMoveCleanupJob,
  listUnresolvedMoveCleanupReferences,
  retryExhaustedMoveCleanupJobs
} from "./move-cleanup-repository.ts";
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

/**
 * An unresolved cleanup row owns deletion of its captured physical object.
 * A successor must not adopt that key until the handler has reached a terminal
 * state, otherwise a non-cancellable remote DELETE could land after adoption.
 */
export async function assertObjectNotPendingCleanup(
  target: Awaited<ReturnType<typeof getStorageBackend>>,
  prefix: "media" | "thumbs",
  key: string
) {
  const references = await listUnresolvedMoveCleanupReferences(prefix, key);
  if (!references.length) return;
  const backends = new Map<
    string,
    Awaited<ReturnType<typeof getStorageBackend>>
  >();
  const cleanupBackend = async (slug: string) => {
    let backend = backends.get(slug);
    if (!backend) {
      backend = await getStorageBackend(slug);
      backends.set(slug, backend);
    }
    return backend;
  };

  for (const reference of references) {
    let matchesTarget = reference.backend === target.slug || (
      storageNamespaceIncludesIdentity(target, reference.namespace_identity)
    );
    if (!matchesTarget && reference.backend !== target.slug) {
      try {
        const backend = await cleanupBackend(reference.backend);
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
    if (!matchesTarget) continue;
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
