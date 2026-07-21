import { errorMessage } from "../core/api-error.ts";
import { logger } from "../core/logger.ts";
import { enqueue } from "../jobs/repository.ts";
import { getStorageBackend } from "./backend-registry.ts";
import { withStorageLocationReadLock } from "./maintenance-lock.ts";
import type { StoragePrefix } from "./object-keys.ts";
import { removeObject } from "./storage.ts";
import { storageNamespaceIdentity } from "./storage-namespace.ts";

export type MoveCleanupObjectInput = {
  prefix: StoragePrefix;
  key: string;
  backend: string;
};

type MoveCleanupObject = MoveCleanupObjectInput & {
  /** Physical namespace captured when the old object became unreferenced. */
  namespace_identity: string;
};

type FailedRemoval = {
  object: MoveCleanupObject;
  error: unknown;
};

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

async function enqueueFailedRemovals(
  imageId: string,
  failures: readonly FailedRemoval[],
  reason: string
) {
  let lastError: unknown;
  for (const delayMs of cleanupEnqueueRetryDelaysMs) {
    await wait(delayMs);
    try {
      await enqueueMoveCleanup(
        imageId,
        failures.map((failure) => failure.object),
        reason
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }

  for (const failure of failures) {
    logger.error("move_cleanup_enqueue_failed", {
      image_id: imageId,
      backend: failure.object.backend,
      namespace_identity: failure.object.namespace_identity,
      prefix: failure.object.prefix,
      key: failure.object.key,
      reason,
      delete_error: errorMessage(failure.error),
      enqueue_error: errorMessage(lastError),
      attempts: cleanupEnqueueRetryDelaysMs.length
    });
  }
}

/** Remove each object independently and preserve every failed deletion. */
export async function removeObjectsOrEnqueueCleanup(
  imageId: string,
  objects: readonly MoveCleanupObjectInput[],
  reason: string
) {
  await withStorageLocationReadLock(async () => {
    // Capture every namespace before deleting anything. If a later removal
    // fails, its durable task can never follow a mutable slug to a new place.
    const captured = await captureCleanupNamespaces(objects);
    const failed: FailedRemoval[] = [];
    for (const object of captured) {
      try {
        await removeObject(object.prefix, object.key, object.backend);
      } catch (error) {
        failed.push({ object, error });
      }
    }
    if (failed.length) {
      // The database location switch has already succeeded at most call sites.
      // Preserve that truth and surface a durable operational error if the
      // bounded queue retries all fail.
      await enqueueFailedRemovals(imageId, failed, reason);
    }
  });
}
