import { listUnresolvedThumbnailRepairKeys } from "./move-cleanup-repository.ts";

const pendingRepairs = new Set<string>();

function repairKey(imageId: string, key: string) {
  return `${imageId}:${key}`;
}

/**
 * Transitional lifecycle for repair receipts created before v4.8.13.
 * Normal thumbnail serving no longer reads this projection; startup and the
 * legacy worker keep it synchronized until that consumer branch is removed.
 */
export async function initializeThumbnailRepairState() {
  const rows = await listUnresolvedThumbnailRepairKeys();
  const next = new Set(
    rows.map((row) => repairKey(row.imageId, row.key))
  );
  pendingRepairs.clear();
  for (const key of next) pendingRepairs.add(key);
}

export function markThumbnailRepairSettled(imageId: string, key: string) {
  pendingRepairs.delete(repairKey(imageId, key));
}
