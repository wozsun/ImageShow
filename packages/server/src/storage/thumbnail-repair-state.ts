import { listUnresolvedThumbnailRepairKeys } from "./move-cleanup-repository.ts";

const pendingRepairs = new Set<string>();
let initialized = false;

function repairKey(imageId: string, key: string) {
  return `${imageId}:${key}`;
}

/**
 * The supported topology runs one ImageShow process, so an in-process
 * projection can remove one PostgreSQL lookup from every thumbnail.
 * PostgreSQL remains authoritative and rebuilds this projection before HTTP
 * readiness on every process start.
 */
export async function initializeThumbnailRepairState() {
  const rows = await listUnresolvedThumbnailRepairKeys();
  const next = new Set(
    rows.map((row) => repairKey(row.imageId, row.key))
  );
  pendingRepairs.clear();
  for (const key of next) pendingRepairs.add(key);
  initialized = true;
}

export function markThumbnailRepairPending(imageId: string, key: string) {
  pendingRepairs.add(repairKey(imageId, key));
}

export function markThumbnailRepairSettled(imageId: string, key: string) {
  pendingRepairs.delete(repairKey(imageId, key));
}

export function thumbnailRepairIsPendingInMemory(
  imageId: string,
  key: string
) {
  // Fail closed for CLI/tests that intentionally import serving before the
  // normal startup sequence has rebuilt the projection.
  return !initialized || pendingRepairs.has(repairKey(imageId, key));
}
