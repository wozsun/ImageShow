import { ApiError } from "../core/api-error.ts";
import { enqueue } from "../jobs/repository.ts";
import { listUnresolvedMoveCleanupReferences } from "../jobs/repository.ts";
import { getStorageBackend } from "./backend-registry.ts";
import { withStorageLocationReadLock } from "./maintenance-lock.ts";
import type { StoragePrefix } from "./object-keys.ts";
import {
  shareStorageNamespace,
  storageNamespaceIdentity,
  storageNamespaceIncludesIdentity
} from "./storage-namespace.ts";

export type MoveCleanupObjectInput = {
  prefix: StoragePrefix;
  key: string;
  backend: string;
};

type MoveCleanupObject = MoveCleanupObjectInput & {
  /** Physical namespace captured when the old object became unreferenced. */
  namespace_identity: string;
};

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
      reference.namespace_identity
        ? storageNamespaceIncludesIdentity(target, reference.namespace_identity)
        : false
    );
    if (!matchesTarget && reference.backend !== target.slug) {
      try {
        const backend = await cleanupBackend(reference.backend);
        matchesTarget = reference.namespace_identity
          ? storageNamespaceIncludesIdentity(
              backend,
              reference.namespace_identity
            ) && shareStorageNamespace(backend, target)
          : shareStorageNamespace(backend, target);
      } catch {
        // If the lease owner can no longer be resolved, refusing reuse is
        // safer than racing an already-issued remote DELETE. This also covers
        // legacy payloads that did not capture a namespace identity.
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

async function captureCleanupNamespaces(
  objects: readonly MoveCleanupObjectInput[]
): Promise<MoveCleanupObject[]> {
  const identities = new Map<string, string>();
  const captured: MoveCleanupObject[] = [];
  for (const object of objects) {
    let identity = identities.get(object.backend);
    if (!identity) {
      identity = storageNamespaceIdentity(await getStorageBackend(object.backend));
      identities.set(object.backend, identity);
    }
    captured.push({ ...object, namespace_identity: identity });
  }
  return captured;
}

/**
 * Queue cleanup against the physical namespace observed at enqueue time. The
 * deterministic key still deduplicates active work; terminal history can be
 * reset by the repository when the same object needs cleanup again.
 */
async function enqueueMoveCleanup(
  imageId: string,
  objects: readonly MoveCleanupObject[],
  reason: string
) {
  if (!objects.length) return;
  const cleanupKey = objects
    .map((object) => `${object.backend}:${object.prefix}:${object.key}`)
    .join("|");
  await enqueue(
    "move.cleanup",
    imageId,
    { objects, reason },
    `move.cleanup:${imageId}:${cleanupKey}`
  );
}

function wait(delayMs: number) {
  return delayMs > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    : Promise.resolve();
}

async function enqueueMoveCleanupWithRetry(
  imageId: string,
  objects: readonly MoveCleanupObject[],
  reason: string,
  signal: AbortSignal
) {
  let lastError: unknown;
  for (const delayMs of cleanupEnqueueRetryDelaysMs) {
    signal.throwIfAborted();
    await wait(delayMs);
    signal.throwIfAborted();
    try {
      await enqueueMoveCleanup(imageId, objects, reason);
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
    const captured = await captureCleanupNamespaces(objects);
    signal.throwIfAborted();
    await enqueueMoveCleanupWithRetry(imageId, captured, reason, signal);
    signal.throwIfAborted();
  });
}
