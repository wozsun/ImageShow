export const READY_IMAGE_EXACT_SYNC_MAX_ITEMS = 500;

export type ImageMutationSyncDecision =
  | { mode: "none"; affectedCount: 0 }
  | { mode: "exact"; affectedCount: number }
  | { mode: "rebuild"; affectedCount: number };

export type ImageMutationSyncResult =
  | {
    mode: "none";
    affectedCount: 0;
    cacheAction: "none";
  }
  | {
    mode: "exact";
    affectedCount: number;
    cacheAction:
      | "synchronized"
      | "rebuild_requested"
      | "not_initialized"
      | "not_needed";
  }
  | {
    mode: "rebuild";
    affectedCount: number;
    cacheAction: "rebuild_requested" | "not_initialized" | "not_needed";
  };

export function decideImageMutationSync(
  affectedCount: number
): ImageMutationSyncDecision {
  if (!Number.isSafeInteger(affectedCount) || affectedCount < 0) {
    throw new Error("Image mutation affected count must be a non-negative integer");
  }
  if (affectedCount === 0) return { mode: "none", affectedCount: 0 };
  return affectedCount <= READY_IMAGE_EXACT_SYNC_MAX_ITEMS
    ? { mode: "exact", affectedCount }
    : { mode: "rebuild", affectedCount };
}
