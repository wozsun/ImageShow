import type { PoolClient } from "pg";
import type { Brightness, Device } from "@imageshow/shared";
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
import { linkThumbnailKey, storageObjectKey, thumbnailObjectKey } from "../storage/image-paths.ts";
import { copyObject, pruneEmptyStorageDirs } from "../storage/storage.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import type { StoragePrefix } from "../storage/object-keys.ts";
import { removeObjectsOrEnqueueCleanup } from "../storage/move-cleanup.ts";

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

export async function ensureTheme(client: PoolClient, slug: string) {
  if (!slug || slug === "none") return false;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [vocabularyMutationLockKey("theme", slug)]);
  return insertTheme(client, slug);
}

/**
 * Use only while the caller owns vocabularyMutationLockKey("theme", slug).
 * This avoids reacquiring the same advisory lock from a different pool
 * connection when an image-location mutation also needs the theme lock.
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
    "SELECT id, device, brightness, ext, object_key, storage_slug, is_link, status FROM metadata WHERE theme=$1 ORDER BY device, brightness, id",
    [theme]
  )).rows as Array<{ id: string; device: Device; brightness: Brightness; ext: string; object_key: string; storage_slug: string; is_link: boolean; status: string }>;
  if (!images.length) return [];
  const concurrency = getRuntimeConfig().background_job.theme_reassign_concurrency;

  const results = await mapWithConcurrency(images, concurrency, (candidate) =>
    withImageStorageMutationLock(candidate.id, async () => {
      const image = (await pool.query(
        `SELECT id, device, brightness, ext, object_key, storage_slug, is_link, status
           FROM metadata
          WHERE id=$1 AND theme=$2`,
        [candidate.id, theme]
      )).rows[0] as typeof candidate | undefined;
      if (!image) return [] as ThemeLookupInvalidation[];

      const destinationObjects: Array<{
        prefix: StoragePrefix;
        key: string;
        backend: string;
      }> = [];
      const sourceObjects: typeof destinationObjects = [];
      const nextObjectKey = image.is_link
        ? image.object_key
        : storageObjectKey(
            image.device,
            image.brightness,
            "none",
            image.id,
            image.ext
          );

      try {
        if (image.is_link) {
          const oldThumbKey = linkThumbnailKey(
            image.device,
            image.brightness,
            theme,
            image.id
          );
          const newThumbKey = linkThumbnailKey(
            image.device,
            image.brightness,
            "none",
            image.id
          );
          if (oldThumbKey !== newThumbKey) {
            await copyObject("link", oldThumbKey, "link", newThumbKey, image.storage_slug);
            destinationObjects.push({
              prefix: "link",
              key: newThumbKey,
              backend: image.storage_slug
            });
            sourceObjects.push({
              prefix: "link",
              key: oldThumbKey,
              backend: image.storage_slug
            });
          }
        } else if (nextObjectKey !== image.object_key) {
          const oldThumbKey = thumbnailObjectKey(image.object_key);
          const newThumbKey = thumbnailObjectKey(nextObjectKey);
          await copyObject(
            "media",
            image.object_key,
            "media",
            nextObjectKey,
            image.storage_slug
          );
          destinationObjects.push({
            prefix: "media",
            key: nextObjectKey,
            backend: image.storage_slug
          });
          await copyObject(
            "thumbs",
            oldThumbKey,
            "thumbs",
            newThumbKey,
            image.storage_slug
          );
          destinationObjects.push({
            prefix: "thumbs",
            key: newThumbKey,
            backend: image.storage_slug
          });
          sourceObjects.push(
            { prefix: "media", key: image.object_key, backend: image.storage_slug },
            { prefix: "thumbs", key: oldThumbKey, backend: image.storage_slug }
          );
        }

        const switched = await pool.query(
          `UPDATE metadata
              SET theme='none', object_key=$3, updated_at=now()
            WHERE id=$1 AND theme=$2 AND storage_slug=$4 AND object_key=$5`,
          [image.id, theme, nextObjectKey, image.storage_slug, image.object_key]
        );
        if (!switched.rowCount) {
          await cleanupThemeMoveObjects(
            image.id,
            destinationObjects,
            "theme_reassign_compare_and_swap_failed"
          );
          return [];
        }
      } catch (error) {
        await cleanupThemeMoveObjects(
          image.id,
          destinationObjects,
          "theme_reassign_failed"
        );
        throw error;
      }

      await cleanupThemeMoveObjects(
        image.id,
        sourceObjects,
        "theme_reassign_source_cleanup"
      );
      await pruneEmptyStorageDirs(image.storage_slug).catch(() => undefined);
      return image.is_link || nextObjectKey === image.object_key
        ? [{ id: image.id }]
        : [
            { id: image.id, object_key: image.object_key },
            { id: image.id, object_key: nextObjectKey }
          ];
    })
  );
  return results.flat();
}

async function cleanupThemeMoveObjects(
  imageId: string,
  objects: Array<{ prefix: StoragePrefix; key: string; backend: string }>,
  reason: string
) {
  await removeObjectsOrEnqueueCleanup(imageId, objects, reason);
}

async function deleteThemeUnderLock(slug: string) {
  const exists = (await pool.query("SELECT 1 FROM theme WHERE slug=$1", [slug])).rowCount;
  if (!exists) return { deleted: false, lookupInvalidations: [] as ThemeLookupInvalidation[] };

  const lookupInvalidations = await reassignThemeImagesToNone(slug);
  const deleted = Boolean((await pool.query("DELETE FROM theme WHERE slug = $1", [slug])).rowCount);
  return { deleted, lookupInvalidations };
}

export async function deleteTheme(slug: string) {
  if (slug === "none") {
    throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be deleted", { slug });
  }
  const result = await withVocabularyMutationLock(
    "theme",
    slug,
    () => deleteThemeUnderLock(slug)
  );
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
    const result = await withVocabularyMutationLock(
      "theme",
      slug,
      () => deleteThemeUnderLock(slug)
    );
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
