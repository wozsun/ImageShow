import type { PoolClient } from "pg";
import { pool } from "../core/database/pools.ts";
import { ApiError } from "../core/api-error.ts";
import {
  assertVocabularyCreated,
  assertVocabularyFound,
  assertVocabularySlug,
  synchronizeVocabularyMutation,
  withVocabularyMutationLock
} from "../vocab/mutation-sync.ts";
import {
  executeThemeImageReassignmentPlan,
  readThemeReassignPlan,
  reassignThemeImagesToNone,
  type ThemeReassignProgress
} from "../images/storage-location/theme-reassignment.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";

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
    const attempt = async (
      upperBoundImageId: string | null,
      exactReadyLimit: number | null
    ) => {
      const reassigned = await reassignThemeImagesToNone(
        slug,
        upperBoundImageId,
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
    const result = await executeThemeImageReassignmentPlan(
      progress.readyCommitted + plan.affectedCount,
      (exactReadyLimit) => attempt(
        plan.upperBoundImageId,
        exactReadyLimit
      ),
      async () => {
        let upperBoundImageId = plan.upperBoundImageId;
        for (;;) {
          const rebuildResult = await attempt(upperBoundImageId, null);
          if (!rebuildResult.retry) return rebuildResult;
          upperBoundImageId = (
            await readThemeReassignPlan(slug)
          ).upperBoundImageId;
        }
      }
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
