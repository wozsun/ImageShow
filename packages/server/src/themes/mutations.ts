import type { PoolClient } from "pg";
import { pool } from "../core/database/pools.ts";
import { withTransaction } from "../core/database/transactions.ts";
import { ApiError } from "../core/api-error.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  synchronizeVocabularyMutation,
  vocabularyMutationLockKey,
  withVocabularyMutationLock
} from "../vocab/mutation-sync.ts";
import {
  imageStorageMutationLockKey,
  withStorageLocationReadAndAdvisoryLocks
} from "../storage/maintenance-lock.ts";
import {
  discardPreparedImageRelocation,
  discardPreparedImageRelocationIfUnreferenced,
  enqueuePreparedImageSourceCleanup,
  prepareVerifiedImageRelocation,
  type RelocatableImage
} from "../storage/migration/image-relocation.ts";
import {
  withImageMutationSync,
  withPlannedImageMutationRebuild
} from "../images/mutation-sync.ts";
import {
  READY_IMAGE_EXACT_SYNC_MAX_ITEMS,
  decideImageMutationSync
} from "../images/mutation-sync-policy.ts";
import { bumpReadyImageRevision } from "../images/ready-cache/revision.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";

const THEME_REASSIGN_PAGE_SIZE = 100;

type ThemeReassignImage = RelocatableImage & { status: string };
type ThemeReassignPlan = {
  affectedCount: number;
  throughId: string | null;
};
type ThemeReassignProgress = {
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

async function insertTheme(client: PoolClient, slug: string) {
  if (!slug || slug === "none") return false;
  const result = await client.query(
    `INSERT INTO theme(slug, sort_order)
     VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM theme))
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug`,
    [slug]
  );
  return Boolean(result.rowCount);
}

/**
 * Use only while the caller owns vocabularyMutationLockKey("theme", slug).
 * This avoids acquiring the same advisory lock from the transaction client
 * after the storage/vocabulary/image compound lease is already held.
 */
export function ensureThemeWithMutationLockHeld(
  client: PoolClient,
  slug: string
) {
  return insertTheme(client, slug);
}

export async function createTheme(slug: string, displayName: string) {
  assertVocabularySlug("theme", slug, { reserved: ["none"] });

  await withVocabularyMutationLock("theme", slug, async (signal) => {
    signal.throwIfAborted();
    const result = await pool.query(
      `INSERT INTO theme(slug, display_name, sort_order)
       VALUES($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM theme))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug, displayName]
    );
    signal.throwIfAborted();
    assertVocabularyCreated("theme", slug, result.rowCount);
  });
  await synchronizeVocabularyMutation({ entity: "theme" });
}

export async function updateThemeDisplayName(slug: string, displayName: string) {
  if (slug === "none") throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be renamed", { slug });
  const result = await pool.query("UPDATE theme SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  assertVocabularyFound("theme", result.rowCount);
  await synchronizeVocabularyMutation({ entity: "theme" });
}

export async function reorderThemes(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE theme t SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE t.slug = v.slug AND t.slug <> 'none'`,
    [slugs]
  );
  await synchronizeVocabularyMutation({ entity: "theme" });
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
          await discardPreparedImageRelocation(
            relocation,
            "theme_reassign_compare_and_swap_failed"
          );
        }
        return switched ? "committed" : "skipped";
      } catch (error) {
        try {
          await discardPreparedImageRelocationIfUnreferenced(
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

async function reassignThemeImagesToNone(
  theme: string,
  throughId: string | null,
  progress: ThemeReassignProgress,
  exactReadyLimit: number | null
) {
  if (!throughId) return { deferred: false };
  const concurrency = getRuntimeConfig().background_job.theme_reassign_concurrency;
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
      [theme, afterId, throughId, THEME_REASSIGN_PAGE_SIZE]
    )).rows as ThemeReassignImage[];
    if (!images.length) return { deferred: false };
    const results = await mapWithWorkerPool(images, concurrency, (candidate) => (
      reassignThemeImageToNone(
        theme,
        candidate,
        progress,
        exactReadyLimit
      )
    ));
    if (results.includes("deferred")) return { deferred: true };
    afterId = images.at(-1)!.id;
    if (images.length < THEME_REASSIGN_PAGE_SIZE) {
      return { deferred: false };
    }
  }
}

async function readThemeReassignPlan(
  theme: string
): Promise<ThemeReassignPlan> {
  const row = (await pool.query(
    `SELECT (count(*) FILTER (WHERE status='ready'))::int AS affected_count,
            max(id::text) AS through_id
       FROM metadata
      WHERE theme=$1`,
    [theme]
  )).rows[0] as {
    affected_count?: number;
    through_id?: string | null;
  } | undefined;
  return {
    affectedCount: Number(row?.affected_count ?? 0),
    throughId: row?.through_id ?? null
  };
}

async function deleteThemeWhenUnreferencedUnderLock(
  slug: string,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const state = (await pool.query(
    `SELECT EXISTS(SELECT 1 FROM theme WHERE slug=$1) AS theme_exists,
            EXISTS(SELECT 1 FROM metadata WHERE theme=$1) AS image_exists`,
    [slug]
  )).rows[0] as { theme_exists: boolean; image_exists: boolean };
  signal.throwIfAborted();
  if (!state.theme_exists) return { deleted: false, retry: false };
  if (state.image_exists) return { deleted: false, retry: true };

  const deleted = Boolean((await pool.query(
    "DELETE FROM theme WHERE slug=$1",
    [slug]
  )).rowCount);
  signal.throwIfAborted();
  return { deleted, retry: false };
}

async function deleteThemeAndReassign(
  slug: string,
  progress: ThemeReassignProgress
) {
  while (true) {
    const plan = await readThemeReassignPlan(slug);
    const decision = decideImageMutationSync(
      progress.readyCommitted + plan.affectedCount
    );
    const attempt = async (
      throughId: string | null,
      exactReadyLimit: number | null
    ) => {
      const reassigned = await reassignThemeImagesToNone(
        slug,
        throughId,
        progress,
        exactReadyLimit
      );
      if (reassigned.deferred) {
        return { deleted: false, retry: true };
      }
      return withVocabularyMutationLock(
        "theme",
        slug,
        (signal) => deleteThemeWhenUnreferencedUnderLock(slug, signal)
      );
    };
    if (decision.mode === "rebuild") {
      return withPlannedImageMutationRebuild(
        decision,
        async () => {
          let throughId = plan.throughId;
          for (;;) {
            const result = await attempt(throughId, null);
            if (!result.retry) return result.deleted;
            throughId = (await readThemeReassignPlan(slug)).throughId;
          }
        }
      );
    }
    const result = await attempt(
      plan.throughId,
      READY_IMAGE_EXACT_SYNC_MAX_ITEMS
    );
    if (!result.retry) {
      return result.deleted;
    }
  }
}

export async function deleteTheme(slug: string) {
  if (slug === "none") {
    throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be deleted", { slug });
  }
  const progress: ThemeReassignProgress = {
    readyCommitted: 0,
    readyReserved: 0
  };
  let synchronized = false;
  try {
    const deleted = await deleteThemeAndReassign(slug, progress);
    assertVocabularyFound("theme", deleted ? 1 : 0);
    await synchronizeVocabularyMutation({ entity: "theme" });
    synchronized = true;
  } finally {
    if (!synchronized && progress.readyCommitted > 0) {
      await invalidateEntityCountCaches(["theme"]);
    }
  }
}
