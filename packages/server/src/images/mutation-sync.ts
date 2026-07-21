import { syncRandomImages } from "../random/random-cache.ts";
import {
  invalidateImageCaches,
  type ImageLookupInvalidationEntry,
} from "./image-cache.ts";

export type ImageMutationSyncPlan = {
  id: string;
  md5?: string;
  lookupEntries?: readonly ImageLookupInvalidationEntry[];
};

export type ImageMutationSyncBatch = {
  add(plan: ImageMutationSyncPlan): void;
  flush(): Promise<ImageMutationSyncSummary>;
};

type ImageMutationSyncSummary = {
  randomPoolFullRebuildTriggered: boolean;
};

function lookupEntryKey(entry: ImageLookupInvalidationEntry) {
  return `${entry.id ?? ""}\u0000${entry.object_key ?? ""}\u0000${entry.thumb_key ?? ""}`;
}

/**
 * Collects the derived-state work caused by one or more committed image
 * mutations. A batch-update request uses one collector for all metadata and tag
 * writes, so PostgreSQL remains the source of truth while each Redis repair is
 * performed once after the request's last domain mutation.
 */
export function createImageMutationSyncBatch(): ImageMutationSyncBatch {
  const imageIds = new Set<string>();
  const md5s = new Set<string>();
  const lookupEntries = new Map<string, ImageLookupInvalidationEntry>();
  let shouldInvalidateImageReads = false;

  return {
    add(plan) {
      imageIds.add(plan.id);
      if (plan.md5) md5s.add(plan.md5);
      for (const entry of plan.lookupEntries ?? []) {
        lookupEntries.set(lookupEntryKey(entry), { ...entry });
      }
      shouldInvalidateImageReads = true;
    },

    async flush() {
      if (!imageIds.size) return { randomPoolFullRebuildTriggered: false };

      const pendingImageIds = [...imageIds];
      const pendingMd5s = [...md5s];
      const pendingLookupEntries = [...lookupEntries.values()];
      const invalidateImageReads = shouldInvalidateImageReads;

      // Clear before starting I/O. A mutation that is added while this flush is
      // in flight belongs to the next flush instead of being silently dropped.
      imageIds.clear();
      md5s.clear();
      lookupEntries.clear();
      shouldInvalidateImageReads = false;

      const repairs = await Promise.allSettled([
        syncRandomImages(pendingImageIds),
        invalidateImageReads
          ? invalidateImageCaches({
              lookupEntries: pendingLookupEntries,
              md5s: pendingMd5s
            })
          : Promise.resolve()
      ]);
      const failedRepair = repairs.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failedRepair) throw failedRepair.reason;
      const randomSync = repairs[0];
      return {
        randomPoolFullRebuildTriggered: randomSync.status === "fulfilled"
          && randomSync.value.fullRebuildTriggered,
      };
    },
  };
}

export async function applyOrCollectImageMutationSync(
  plan: ImageMutationSyncPlan,
  batch?: ImageMutationSyncBatch,
) {
  const target = batch ?? createImageMutationSyncBatch();
  target.add(plan);
  if (!batch) await target.flush();
}
