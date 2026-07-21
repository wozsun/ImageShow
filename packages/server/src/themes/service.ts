import type { PoolClient } from "pg";
import { pool } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithConcurrency } from "../core/concurrency.ts";
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
  completePreparedImageRelocation,
  discardPreparedImageRelocation,
  discardPreparedImageRelocationIfUnreferenced,
  prepareVerifiedImageRelocation,
  type RelocatableImage
} from "../storage/image-relocation.ts";

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

  await withVocabularyMutationLock("theme", slug, async () => {
    const result = await pool.query(
      `INSERT INTO theme(slug, display_name, sort_order)
       VALUES($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM theme))
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [slug, displayName]
    );
    assertVocabularyCreated("theme", slug, result.rowCount);
  });
  await synchronizeVocabularyMutation({ entity: "theme" });
}

export async function setThemeDisplayName(slug: string, displayName: string) {
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

type ThemeLookupInvalidation = {
  id: string;
  object_key?: string;
};

async function reassignThemeImagesToNone(theme: string): Promise<ThemeLookupInvalidation[]> {
  const images = (await pool.query(
    `SELECT id, device, brightness, theme, ext, md5, object_key,
            storage_slug
       FROM metadata
      WHERE theme=$1
      ORDER BY device, brightness, id`,
    [theme]
  )).rows as Array<RelocatableImage>;
  if (!images.length) return [];
  const concurrency = getRuntimeConfig().background_job.theme_reassign_concurrency;

  const results = await mapWithConcurrency(images, concurrency, (candidate) =>
    withStorageLocationReadAndAdvisoryLocks([
      {
        key: vocabularyMutationLockKey("theme", theme),
        mode: "shared"
      },
      { key: imageStorageMutationLockKey(candidate.id) }
    ], async () => {
      const image = (await pool.query(
        `SELECT id, device, brightness, theme, ext, md5, object_key,
                storage_slug
           FROM metadata
          WHERE id=$1 AND theme=$2`,
        [candidate.id, theme]
      )).rows[0] as RelocatableImage | undefined;
      if (!image) return [] as ThemeLookupInvalidation[];

      const relocation = await prepareVerifiedImageRelocation(
        image,
        {
          device: image.device,
          brightness: image.brightness,
          theme: "none"
        },
        "theme_reassign"
      );
      try {
        const switched = await pool.query(
          `UPDATE metadata
              SET theme='none', object_key=$3, updated_at=now()
            WHERE id=$1
              AND theme=$2
              AND storage_slug=$4
              AND object_key=$5
              AND device=$6
              AND brightness=$7`,
          [
            image.id,
            theme,
            relocation.nextObjectKey,
            image.storage_slug,
            image.object_key,
            image.device,
            image.brightness
          ]
        );
        if (!switched.rowCount) {
          await discardPreparedImageRelocation(
            relocation,
            "theme_reassign_compare_and_swap_failed"
          );
          return [];
        }
      } catch (error) {
        await discardPreparedImageRelocationIfUnreferenced(
          relocation,
          "theme_reassign_failed"
        );
        throw error;
      }

      await completePreparedImageRelocation(
        relocation,
        "theme_reassign_source_cleanup"
      );
      return relocation.nextObjectKey === image.object_key
        ? [{ id: image.id }]
        : [
            { id: image.id, object_key: image.object_key },
            { id: image.id, object_key: relocation.nextObjectKey }
          ];
    })
  );
  return results.flat();
}

async function deleteThemeWhenUnreferencedUnderLock(slug: string) {
  const state = (await pool.query(
    `SELECT EXISTS(SELECT 1 FROM theme WHERE slug=$1) AS theme_exists,
            EXISTS(SELECT 1 FROM metadata WHERE theme=$1) AS image_exists`,
    [slug]
  )).rows[0] as { theme_exists: boolean; image_exists: boolean };
  if (!state.theme_exists) return { deleted: false, retry: false };
  if (state.image_exists) return { deleted: false, retry: true };

  const deleted = Boolean((await pool.query(
    "DELETE FROM theme WHERE slug=$1",
    [slug]
  )).rowCount);
  return { deleted, retry: false };
}

async function deleteThemeAndReassign(slug: string) {
  const lookupInvalidations: ThemeLookupInvalidation[] = [];
  while (true) {
    lookupInvalidations.push(...await reassignThemeImagesToNone(slug));
    const result = await withVocabularyMutationLock(
      "theme",
      slug,
      () => deleteThemeWhenUnreferencedUnderLock(slug)
    );
    if (!result.retry) {
      return { deleted: result.deleted, lookupInvalidations };
    }
  }
}

export async function deleteTheme(slug: string) {
  if (slug === "none") {
    throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be deleted", { slug });
  }
  const result = await deleteThemeAndReassign(slug);
  assertVocabularyFound("theme", result.deleted ? 1 : 0);
  if (result.lookupInvalidations.length) {
    await synchronizeVocabularyMutation({
      entity: "theme",
      lookupEntries: result.lookupInvalidations,
      imageDataChanged: true,
      random: { mode: "rebuild" }
    });
  } else await synchronizeVocabularyMutation({ entity: "theme" });
}

export async function deleteThemes(slugs: string[]) {
  const targets = [...new Set(slugs)].filter((slug) => slug !== "none");
  if (!targets.length) return;
  const lookupInvalidations: ThemeLookupInvalidation[] = [];
  let deletedAny = false;
  for (const slug of targets) {
    const result = await deleteThemeAndReassign(slug);
    lookupInvalidations.push(...result.lookupInvalidations);
    if (result.deleted) deletedAny = true;
  }
  if (lookupInvalidations.length) {
    await synchronizeVocabularyMutation({
      entity: "theme",
      lookupEntries: lookupInvalidations,
      imageDataChanged: true,
      random: { mode: "rebuild" }
    });
  } else if (deletedAny) {
    await synchronizeVocabularyMutation({ entity: "theme" });
  }
}
