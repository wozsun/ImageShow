import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { pool } from "../../core/database/pools.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import {
  vocabularyMutationLockKey
} from "../../vocab/mutation-sync.ts";
import {
  imageStorageMutationLockKey,
  withStorageLocationReadAndAdvisoryLocks
} from "../../storage/maintenance-lock.ts";
import {
  IMAGE_TRANSFER_CONCURRENCY,
  withImageTransferAdmission
} from "../../storage/objects/image-transfer-admission.ts";
import {
  enqueuePreparedImageRelocationCleanup,
  enqueuePreparedImageRelocationCleanupIfUnreferenced,
  enqueuePreparedImageSourceCleanup,
  prepareVerifiedImageRelocation,
  type RelocatableImage
} from "./classification-relocation.ts";
import {
  withImageMutationSync,
  withPlannedImageMutationRebuild
} from "../mutation-sync.ts";
import {
  READY_IMAGE_EXACT_SYNC_MAX_ITEMS,
  decideImageMutationSync
} from "../mutation-sync-policy.ts";
import { bumpReadyImageRevision } from "../ready-cache/revision.ts";

const THEME_REASSIGN_PAGE_SIZE = 100;
const themeReassignAdmissionSignal = new AbortController().signal;

type ThemeReassignImage = RelocatableImage & { status: string };

type ThemeReassignPlan = {
  affectedCount: number;
  upperBoundImageId: string | null;
};

export type ThemeReassignProgress = {
  readyCommitted: number;
  readyReserved: number;
};

type ThemeReassignImageResult = "committed" | "deferred" | "skipped";

function reserveReadyReassignment(
  progress: ThemeReassignProgress,
  exactReadyLimit: number | null
) {
  if (
    exactReadyLimit !== null
    && progress.readyCommitted + progress.readyReserved >= exactReadyLimit
  ) {
    return null;
  }
  progress.readyReserved += 1;
  let released = false;
  return (committed: boolean) => {
    if (released) return;
    released = true;
    progress.readyReserved -= 1;
    if (committed) progress.readyCommitted += 1;
  };
}

async function reassignThemeImageToNone(
  theme: string,
  candidate: ThemeReassignImage,
  progress: ThemeReassignProgress,
  exactReadyLimit: number | null
): Promise<ThemeReassignImageResult> {
  return withStorageLocationReadAndAdvisoryLocks([
    {
      key: vocabularyMutationLockKey("theme", theme),
      mode: "shared"
    },
    { key: imageStorageMutationLockKey(candidate.id) }
  ], async (signal) => {
    signal.throwIfAborted();
    const image = (await pool.query(
      `SELECT id, device, brightness, theme, ext, md5, object_key,
              storage_slug, status
         FROM metadata
        WHERE id=$1 AND theme=$2`,
      [candidate.id, theme]
    )).rows[0] as ThemeReassignImage | undefined;
    signal.throwIfAborted();
    if (!image) return "skipped";

    const releaseReadyReservation = image.status === "ready"
      ? reserveReadyReassignment(progress, exactReadyLimit)
      : undefined;
    if (releaseReadyReservation === null) return "deferred";

    let readyCommitted = false;
    try {
      const relocation = await prepareVerifiedImageRelocation(
        image,
        {
          device: image.device,
          brightness: image.brightness,
          theme: "none"
        },
        "theme_reassign",
        signal
      );
      try {
        signal.throwIfAborted();
        const switched = await withImageMutationSync(
          async (mutationBatch) => {
            const committed = await withTransaction(async (client) => {
              const result = await client.query(
                `UPDATE metadata
                    SET theme='none',
                        object_key=$3,
                        thumbnail_size=COALESCE($4, thumbnail_size),
                        updated_at=now()
                  WHERE id=$1
                    AND theme=$2
                    AND storage_slug=$5
                    AND object_key=$6
                    AND device=$7
                    AND brightness=$8
                    AND status=$9`,
                [
                  image.id,
                  theme,
                  relocation.nextObjectKey,
                  relocation.thumbnailSize,
                  image.storage_slug,
                  image.object_key,
                  image.device,
                  image.brightness,
                  image.status
                ]
              );
              if (!result.rowCount) return false;
              await enqueuePreparedImageSourceCleanup(
                client,
                relocation,
                "theme_reassign_source_cleanup"
              );
              if (image.status === "ready") {
                await bumpReadyImageRevision(client);
              }
              signal.throwIfAborted();
              return true;
            });
            if (committed && image.status === "ready") {
              mutationBatch.add({ id: image.id });
            }
            return committed;
          }
        );
        readyCommitted = switched && image.status === "ready";
        if (!switched) {
          await enqueuePreparedImageRelocationCleanup(
            relocation,
            "theme_reassign_compare_and_swap_failed"
          );
        }
        return switched ? "committed" : "skipped";
      } catch (error) {
        try {
          await enqueuePreparedImageRelocationCleanupIfUnreferenced(
            relocation,
            "theme_reassign_failed"
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Theme reassignment failed and candidate cleanup could not be queued"
          );
        }
        throw error;
      }
    } finally {
      releaseReadyReservation?.(readyCommitted);
    }
  });
}

export async function reassignThemeImagesToNone(
  theme: string,
  upperBoundImageId: string | null,
  progress: ThemeReassignProgress,
  exactReadyLimit: number | null
) {
  if (!upperBoundImageId) return { deferred: false };
  let afterId: string | null = null;
  for (;;) {
    const images = (await pool.query(
      `SELECT id, device, brightness, theme, ext, md5, object_key,
              storage_slug, status
         FROM metadata
        WHERE theme=$1
          AND ($2::uuid IS NULL OR id > $2::uuid)
          AND id <= $3::uuid
        ORDER BY id
        LIMIT $4`,
      [theme, afterId, upperBoundImageId, THEME_REASSIGN_PAGE_SIZE]
    )).rows as ThemeReassignImage[];
    if (!images.length) return { deferred: false };
    const results = await mapWithWorkerPool(
      images,
      IMAGE_TRANSFER_CONCURRENCY,
      (candidate) => withImageTransferAdmission(
        themeReassignAdmissionSignal,
        () => reassignThemeImageToNone(
          theme,
          candidate,
          progress,
          exactReadyLimit
        )
      )
    );
    if (results.includes("deferred")) return { deferred: true };
    afterId = images.at(-1)!.id;
    if (images.length < THEME_REASSIGN_PAGE_SIZE) {
      return { deferred: false };
    }
  }
}

export async function readThemeReassignPlan(
  theme: string
): Promise<ThemeReassignPlan> {
  const row = (await pool.query(
    `SELECT (count(*) FILTER (WHERE status='ready'))::int AS affected_count,
            max(id::text) AS upper_bound_image_id
       FROM metadata
      WHERE theme=$1`,
    [theme]
  )).rows[0] as {
    affected_count?: number;
    upper_bound_image_id?: string | null;
  } | undefined;
  return {
    affectedCount: Number(row?.affected_count ?? 0),
    upperBoundImageId: row?.upper_bound_image_id ?? null
  };
}

export function executeThemeImageReassignmentPlan<Result>(
  affectedCount: number,
  exactWork: (exactReadyLimit: number) => Promise<Result>,
  rebuildWork: () => Promise<Result>
) {
  const decision = decideImageMutationSync(affectedCount);
  return decision.mode === "rebuild"
    ? withPlannedImageMutationRebuild(decision, rebuildWork)
    : exactWork(READY_IMAGE_EXACT_SYNC_MAX_ITEMS);
}
