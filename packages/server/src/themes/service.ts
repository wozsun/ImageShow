import type { PoolClient } from "pg";
import { slugPattern, type Brightness, type Device } from "@imageshow/shared";
import { pool, withAdvisoryLock, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithConcurrency } from "../core/concurrency.ts";
import {
  invalidateGalleryFacetsCache,
  invalidateImageLookupEntries,
  invalidateImageReadCaches,
} from "../images/image-cache.ts";
import { rebuildRandomPool } from "../random/random-cache.ts";
import {
  invalidateEntityCountCaches,
  refreshEntityVocabularies,
} from "../vocab/vocab-cache.ts";
import { linkThumbnailKey, storageObjectKey, thumbnailObjectKey } from "../storage/image-paths.ts";
import { copyObject, pruneEmptyStorageDirs, removeObject } from "../storage/storage.ts";
import { withStorageMutationLock } from "../storage/maintenance-lock.ts";

export async function ensureTheme(client: PoolClient, slug: string) {
  if (!slug || slug === "none") return false;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [themeMutationLockKey(slug)]);
  const result = await client.query(
    `INSERT INTO theme(slug, sort_order)
     VALUES($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM theme))
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug`,
    [slug]
  );
  return Boolean(result.rowCount);
}

function themeMutationLockKey(slug: string) {
  return `imageshow:theme:${slug}`;
}

async function refreshThemeDefinitionCaches(options: { facets?: boolean } = {}) {
  const tasks: Array<Promise<unknown>> = [
    refreshEntityVocabularies(["theme"]),
    invalidateEntityCountCaches(["theme"]),
  ];
  if (options.facets ?? true) tasks.push(invalidateGalleryFacetsCache());
  await Promise.all(tasks);
}

export async function upsertTheme(slug: string, displayName: string) {
  if (slug === "none" || slug.length > 32 || !slugPattern.test(slug)) {
    throw new ApiError(400, "invalid_theme", "Theme slug must be a lowercase slug (a-z, 0-9, -), <=32 chars", { slug });
  }

  await withAdvisoryLock(themeMutationLockKey(slug), async () => {
    await pool.query(
      `INSERT INTO theme(slug, display_name, sort_order)
       VALUES($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM theme))
       ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
      [slug, displayName]
    );
  });
  await refreshThemeDefinitionCaches();
}

export async function setThemeDisplayName(slug: string, displayName: string) {
  if (slug === "none") throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be renamed", { slug });
  const result = await pool.query("UPDATE theme SET display_name = $2, updated_at = now() WHERE slug = $1", [slug, displayName]);
  if (!result.rowCount) throw new ApiError(404, "not_found", "Theme not found");
  await refreshThemeDefinitionCaches();
}

export async function reorderThemes(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE theme t SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE t.slug = v.slug AND t.slug <> 'none'`,
    [slugs]
  );
  await refreshThemeDefinitionCaches();
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

  const moves = images
    .filter((image) => !image.is_link)
    .map((image) => ({ ...image, newKey: storageObjectKey(image.device, image.brightness, "none", image.id, image.ext) }))
    .filter((move) => move.newKey !== move.object_key);
  const newKeyById = new Map(moves.map((move) => [move.id, move.newKey]));

  const linkThumbMoves = images
    .filter((image) => image.is_link)
    .map((image) => ({
      storage_slug: image.storage_slug,
      oldThumbKey: linkThumbnailKey(image.device, image.brightness, theme, image.id),
      newThumbKey: linkThumbnailKey(image.device, image.brightness, "none", image.id)
    }))
    .filter((move) => move.oldThumbKey !== move.newThumbKey);
  const concurrency = getRuntimeConfig().background_job.theme_reassign_concurrency;

  await mapWithConcurrency(moves, concurrency, async (move) => {
    await copyObject("media", move.object_key, "media", move.newKey, move.storage_slug);
    await copyObject("thumbs", thumbnailObjectKey(move.object_key), "thumbs", thumbnailObjectKey(move.newKey), move.storage_slug);
  });

  await mapWithConcurrency(linkThumbMoves, concurrency, async (move) => {
    await copyObject("link", move.oldThumbKey, "link", move.newThumbKey, move.storage_slug);
  });

  await withTransaction(async (client) => {
    const locked = (await client.query("SELECT id FROM metadata WHERE theme=$1 FOR UPDATE", [theme])).rows as Array<{ id: string }>;
    if (!locked.length) return;
    for (const row of locked) {
      await client.query(
        "UPDATE metadata SET theme='none', object_key=COALESCE($2, object_key), updated_at=now() WHERE id=$1",
        [row.id, newKeyById.get(row.id) ?? null]
      );
    }
  });

  await mapWithConcurrency(moves, concurrency, async (move) => {
    await removeObject("media", move.object_key, move.storage_slug).catch(() => undefined);
    await removeObject("thumbs", thumbnailObjectKey(move.object_key), move.storage_slug).catch(() => undefined);
  });
  await mapWithConcurrency(linkThumbMoves, concurrency, async (move) => {
    await removeObject("link", move.oldThumbKey, move.storage_slug).catch(() => undefined);
  });
  for (const slug of new Set([...moves, ...linkThumbMoves].map((move) => move.storage_slug))) {
    await pruneEmptyStorageDirs(slug).catch(() => undefined);
  }
  return images.flatMap((image) => {
    if (image.is_link) return [{ id: image.id }];
    const newKey = newKeyById.get(image.id);
    return newKey && newKey !== image.object_key
      ? [
          { id: image.id, object_key: image.object_key },
          { id: image.id, object_key: newKey },
        ]
      : [{ id: image.id, object_key: image.object_key }];
  });
}

async function deleteThemeUnderLock(slug: string) {
  const exists = (await pool.query("SELECT 1 FROM theme WHERE slug=$1", [slug])).rowCount;
  if (!exists) return { deleted: false, lookupInvalidations: [] as ThemeLookupInvalidation[] };

  const lookupInvalidations = await withStorageMutationLock(() => reassignThemeImagesToNone(slug));
  const deleted = Boolean((await pool.query("DELETE FROM theme WHERE slug = $1", [slug])).rowCount);
  return { deleted, lookupInvalidations };
}

export async function deleteTheme(slug: string) {
  if (slug === "none") {
    throw new ApiError(400, "invalid_theme", "The reserved 'none' theme cannot be deleted", { slug });
  }
  const result = await withAdvisoryLock(themeMutationLockKey(slug), () => deleteThemeUnderLock(slug));
  if (!result.deleted) throw new ApiError(404, "not_found", "Theme not found");
  if (result.lookupInvalidations.length) {
    await rebuildRandomPool();
    await Promise.all([
      invalidateImageLookupEntries(result.lookupInvalidations),
      invalidateImageReadCaches(),
      refreshThemeDefinitionCaches({ facets: false }),
    ]);
  } else await refreshThemeDefinitionCaches();
}

export async function deleteThemes(slugs: string[]) {
  const targets = [...new Set(slugs)].filter((slug) => slug !== "none");
  if (!targets.length) return { deleted: 0 };
  const lookupInvalidations: ThemeLookupInvalidation[] = [];
  let deleted = 0;
  for (const slug of targets) {
    const result = await withAdvisoryLock(themeMutationLockKey(slug), () => deleteThemeUnderLock(slug));
    lookupInvalidations.push(...result.lookupInvalidations);
    if (result.deleted) deleted += 1;
  }
  if (lookupInvalidations.length) {
    await rebuildRandomPool();
    await Promise.all([
      invalidateImageLookupEntries(lookupInvalidations),
      invalidateImageReadCaches(),
      refreshThemeDefinitionCaches({ facets: false }),
    ]);
  } else if (deleted) await refreshThemeDefinitionCaches();
  return { deleted };
}
