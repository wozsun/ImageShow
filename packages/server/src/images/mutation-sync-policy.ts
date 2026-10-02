export const READY_IMAGE_EXACT_SYNC_MAX_ITEMS = 500;

export type ImageMutationSyncDecision =
  | { mode: "none"; affectedCount: 0 }
  | { mode: "exact"; affectedCount: number }
  | { mode: "rebuild"; affectedCount: number };

export function decideImageMutationSync(affectedCount: number): ImageMutationSyncDecision {
  if (!Number.isSafeInteger(affectedCount) || affectedCount < 0) {
    throw new Error("Image mutation affected count must be a non-negative integer");
  }
  if (affectedCount === 0) return { mode: "none", affectedCount: 0 };
  return affectedCount <= READY_IMAGE_EXACT_SYNC_MAX_ITEMS
    ? { mode: "exact", affectedCount }
    : { mode: "rebuild", affectedCount };
}
