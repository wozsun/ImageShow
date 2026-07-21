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
  objects: readonly MoveCleanupObjectInput[],
  reason: string
) {
  if (!objects.length) return;
  const captured = await captureCleanupNamespaces(objects);
  const cleanupKey = captured
    .map((object) => `${object.backend}:${object.prefix}:${object.key}`)
    .join("|");
  await enqueue(
    "move.cleanup",
    imageId,
    { objects: captured, reason },
    `move.cleanup:${imageId}:${cleanupKey}`
  );
}

/** Remove each object independently and preserve every failed deletion. */
export async function removeObjectsOrEnqueueCleanup(
  imageId: string,
  objects: readonly MoveCleanupObjectInput[],
  reason: string
) {
  await withStorageLocationReadLock(async () => {
    const failed: MoveCleanupObjectInput[] = [];
    for (const object of objects) {
      await removeObject(object.prefix, object.key, object.backend).catch(() => {
        failed.push(object);
      });
    }
    if (failed.length) {
      await enqueueMoveCleanup(imageId, failed, reason).catch(() => undefined);
    }
  });
}
