import { mapWithWorkerPool } from "../core/concurrency.ts";
import { withAdvisoryLocks } from "../core/database/advisory-locks.ts";
import { pool } from "../core/database/pools.ts";
import { withTransaction } from "../core/database/transactions.ts";
import { imageStorageMutationLockKey } from "../storage/maintenance-lock.ts";
import { vocabularyMutationLockKey } from "../vocab/mutation-sync.ts";
import {
  withImageMutationSync,
  withPlannedImageMutationRebuild
} from "./mutation-sync.ts";
import {
  READY_IMAGE_EXACT_SYNC_MAX_ITEMS,
  decideImageMutationSync
} from "./mutation-sync-policy.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

const THEME_REASSIGN_PAGE_SIZE = 100;
const THEME_REASSIGN_CONCURRENCY = 5;

type ThemeReassignImage = {
  id: string;
  status: string;
};

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
  return withAdvisoryLocks([
    {
      key: vocabularyMutationLockKey("theme", theme),
      mode: "shared"
    },
    { key: imageStorageMutationLockKey(candidate.id) }
  ], async (signal) => {
    signal.throwIfAborted();
    const image = (await pool.query(
      `SELECT id, status
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
      const switched = await withImageMutationSync(async (mutationBatch) => {
        const committed = await withTransaction(async (client) => {
          const result = await client.query(
            `UPDATE metadata
                SET theme='none',
                    updated_at=now()
              WHERE id=$1
                AND theme=$2
                AND status=$3`,
            [image.id, theme, image.status]
          );
          if (!result.rowCount) return false;
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
      });
      readyCommitted = switched && image.status === "ready";
      return switched ? "committed" : "skipped";
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
      `SELECT id, status
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
      THEME_REASSIGN_CONCURRENCY,
      (candidate) => reassignThemeImageToNone(
        theme,
        candidate,
        progress,
        exactReadyLimit
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
