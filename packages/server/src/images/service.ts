import type { Pool, PoolClient } from "pg";
import { pool, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithConcurrency } from "../core/concurrency.ts";
import { metadataUpdateInput, parse } from "../core/validation.ts";
import { invalidateImageCaches } from "./image-cache.ts";
import { syncRandomImage, syncRandomImages } from "../random/random-cache.ts";
import { enqueue } from "../jobs/repository.ts";
import { storageObjectKey, thumbnailObjectKey, thumbnailRef } from "../storage/image-paths.ts";
import { copyObject, exists, readStorageBuffer, removeObject } from "../storage/storage.ts";
import { migrateImageStorage, type MigrateRecord } from "../storage/migration.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import { removeObjectsOrEnqueueCleanup } from "../storage/move-cleanup.ts";
import { isReservedSubdomain } from "../themes/host.ts";
import {
  ensureThemeWithMutationLockHeld
} from "../themes/service.ts";
import { ensureAuthor } from "../authors/service.ts";
import {
  invalidateEntityCountCaches,
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind,
  type EntityCountCacheInvalidationBatch,
} from "../vocab/vocab-cache.ts";
import { withVocabularyMutationLock } from "../vocab/mutation-sync.ts";
import { detectBrightness } from "./brightness.ts";
import { deviceFromDimensions, resolveOptionalBrightnessWith, resolveOptionalDeviceWith } from "./classification.ts";
import type { ImageRecord } from "./presenter.ts";
import {
  applyOrCollectImageMutationSync,
  type ImageMutationSyncBatch,
} from "./mutation-sync.ts";

type MutationImageRecord = Pick<
  ImageRecord,
  | "id"
  | "device"
  | "brightness"
  | "theme"
  | "width"
  | "height"
  | "ext"
  | "md5"
  | "object_key"
  | "storage_slug"
  | "is_link"
  | "author"
  | "status"
>;

const mutationImageColumns = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "ext",
  "md5",
  "object_key",
  "storage_slug",
  "is_link",
  "author",
  "status"
].join(", ");

async function detectImageBrightness(image: MutationImageRecord) {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef(image);
  if (!(await exists(thumb.prefix, thumb.key, thumb.slug))) return undefined;
  return detectBrightness(await readStorageBuffer(thumb.prefix, thumb.key, thumb.slug));
}

function detectImageDevice(image: MutationImageRecord) {
  if (image.status !== "ready") return undefined;
  return deviceFromDimensions(image.width, image.height);
}

type ImageMutationOptions = {
  entityCountInvalidationBatch?: EntityCountCacheInvalidationBatch;
  mutationSyncBatch?: ImageMutationSyncBatch;
};

async function applyImageFieldEdits(
  executor: Pool | PoolClient,
  id: string,
  fields: {
    title?: string;
    description?: string;
    source?: string;
    original?: string;
  },
  authorValue: string | null,
  touchAuthor: boolean,
): Promise<MutationImageRecord> {
  const result = await executor.query(
    `UPDATE metadata
        SET title=COALESCE($2,title),
            description=COALESCE($3,description),
            source=COALESCE($4,source),
            original=COALESCE($5,original),
            author=CASE WHEN $7::boolean THEN $6 ELSE author END,
            updated_at=now()
      WHERE id=$1
      RETURNING ${mutationImageColumns}`,
    [id, fields.title, fields.description, fields.source, fields.original, authorValue, touchAuthor],
  );
  return result.rows[0] as MutationImageRecord;
}

export async function deleteImage(id: string) {
  const deleted = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE metadata
          SET status='deleted',
              deleted_at=now(),
              purge_state='idle',
              purge_started_at=NULL,
              purge_error=NULL,
              updated_at=now()
        WHERE id=$1 AND status='ready'
        RETURNING id, object_key, md5`,
      [id]
    );
    if (!result.rowCount) throw new ApiError(404, "not_found", "Ready image not found");
    return result.rows[0] as { id: string; object_key: string; md5: string | null };
  });
  await syncRandomImage(deleted.id);
  await Promise.all([
    invalidateImageCaches({
      lookupEntries: [deleted],
      md5s: [deleted.md5 ?? ""]
    }),
    invalidateEntityCountCaches(["theme", "author"]),
  ]);
}

export async function updateImageMetadata(id: string, body: unknown, options: ImageMutationOptions = {}) {
  const current = (await pool.query(
    `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1`,
    [id]
  )).rows[0] as MutationImageRecord | undefined;
  if (!current) throw new ApiError(404, "not_found", "Image not found");

  const parsed = parse(metadataUpdateInput, body);
  if (parsed.theme && isReservedSubdomain(parsed.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: parsed.theme });

  const touchAuthor = parsed.author !== undefined;
  const authorValue = parsed.author ? parsed.author : null;
  const classificationRequested = parsed.device !== undefined
    || parsed.brightness !== undefined
    || parsed.theme !== undefined;

  if (!classificationRequested) {
    const authorChanged = touchAuthor && authorValue !== current.author;
    const createdAuthor = parsed.author
      ? await ensureAuthor(pool, parsed.author)
      : false;
    await applyImageFieldEdits(pool, id, parsed, authorValue, touchAuthor);
    const cacheTasks: Array<Promise<unknown>> = [applyOrCollectImageMutationSync({
      id,
      md5: current.md5 ?? "",
      lookupEntries: [{ id, object_key: current.object_key }],
    }, options.mutationSyncBatch)];
    if (authorChanged) {
      cacheTasks.push(invalidateOrCollectEntityCountCaches(
        ["author"],
        options.entityCountInvalidationBatch,
      ));
    }
    if (createdAuthor) cacheTasks.push(refreshEntityVocabularies(["author"]));
    await Promise.all(cacheTasks);
    return;
  }

  const mutateImageLocation = () => withImageStorageMutationLock(id, async () => {
    // The image may have moved while this request parsed or classified its
    // input. Re-read after acquiring ownership and derive omitted fields from
    // the current row rather than reverting a concurrent mutation.
    const locationSnapshot = (await pool.query(
      `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1`,
      [id]
    )).rows[0] as MutationImageRecord | undefined;
    if (!locationSnapshot) throw new ApiError(404, "not_found", "Image not found");
    if (locationSnapshot.status !== "ready") {
      throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
    }
    const next = {
      ...parsed,
      device: resolveOptionalDeviceWith(
        parsed.device,
        () => detectImageDevice(locationSnapshot)
      ),
      brightness: await resolveOptionalBrightnessWith(
        parsed.brightness,
        () => detectImageBrightness(locationSnapshot)
      )
    };
    const targetDevice = next.device ?? locationSnapshot.device;
    const targetBrightness = next.brightness ?? locationSnapshot.brightness;
    const targetTheme = next.theme ?? locationSnapshot.theme;
    const sourceIsLink = Boolean(locationSnapshot.is_link);
    const sourceSlug = locationSnapshot.storage_slug;
    const predictedKey = sourceIsLink
      ? locationSnapshot.object_key
      : storageObjectKey(
          targetDevice,
          targetBrightness,
          targetTheme,
          id,
          locationSnapshot.ext
        );
    let preCopiedObjectKey = "";
    let preCopiedLinkThumbKey = "";

    if (!sourceIsLink && predictedKey !== locationSnapshot.object_key) {
      await copyObject("media", locationSnapshot.object_key, "media", predictedKey, sourceSlug);
      preCopiedObjectKey = predictedKey;
    }

    if (sourceIsLink) {
      const oldThumb = thumbnailRef({
          ...locationSnapshot,
        storage_slug: sourceSlug,
        is_link: true,
      });
      const newThumb = thumbnailRef({
          ...locationSnapshot,
        device: targetDevice,
        brightness: targetBrightness,
        theme: targetTheme,
        storage_slug: sourceSlug,
        is_link: true,
      });
      if (oldThumb.key !== newThumb.key) {
        await copyObject("link", oldThumb.key, "link", newThumb.key, sourceSlug);
        preCopiedLinkThumbKey = newThumb.key;
      }
    }

    const client = await pool.connect();
    let sourceImage = locationSnapshot;
    let updated: MutationImageRecord | null = null;
    let committedObjectKey = "";
    let copiedObjectKey = "";
    const createdEntityKinds = new Set<EntityCacheKind>();
    try {
      await client.query("BEGIN");
      const locked = (await client.query(
        `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1 FOR UPDATE`,
        [id]
      )).rows[0] as MutationImageRecord | undefined;
      if (!locked) throw new ApiError(404, "not_found", "Image not found");
      if (locked.status !== "ready") throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
      if (
        locked.storage_slug !== locationSnapshot.storage_slug
        || locked.object_key !== locationSnapshot.object_key
      ) {
        throw new ApiError(
          409,
          "image_location_changed",
          "Image location changed while preparing the category update"
        );
      }
      sourceImage = locked;

      const device = next.device ?? locked.device;
      const brightness = next.brightness ?? locked.brightness;
      const theme = next.theme ?? locked.theme;
      const isLink = Boolean(locked.is_link);
      const nextObjectKey = isLink ? locked.object_key : storageObjectKey(device, brightness, theme, id, locked.ext);

      if (device === locked.device && brightness === locked.brightness && theme === locked.theme) {
        if (next.author && await ensureAuthor(client, next.author)) createdEntityKinds.add("author");
        updated = await applyImageFieldEdits(client, id, next, authorValue, touchAuthor);
        await client.query("COMMIT");
        committedObjectKey = locked.object_key;
      } else {
        if (
          parsed.theme
          && parsed.theme !== "none"
          && await ensureThemeWithMutationLockHeld(client, theme)
        ) {
          createdEntityKinds.add("theme");
        }
        if (next.author && await ensureAuthor(client, next.author)) createdEntityKinds.add("author");

        if (!isLink && nextObjectKey !== locked.object_key) {
          if (preCopiedObjectKey !== nextObjectKey) {
            await copyObject("media", locked.object_key, "media", nextObjectKey, locked.storage_slug);
            copiedObjectKey = nextObjectKey;
          }
        }

        const result = await client.query(
          `UPDATE metadata
              SET device=$2,
                  brightness=$3,
                  theme=$4,
                  object_key=$5,
                  title=COALESCE($6,title),
                  description=COALESCE($7,description),
                  source=COALESCE($8,source),
                  original=COALESCE($9,original),
                  author=CASE WHEN $11::boolean THEN $10 ELSE author END,
                  updated_at=now()
            WHERE id=$1 AND storage_slug=$12 AND object_key=$13
            RETURNING ${mutationImageColumns}`,
          [
            id,
            device,
            brightness,
            theme,
            nextObjectKey,
            next.title,
            next.description,
            next.source,
            next.original,
            authorValue,
            touchAuthor,
            locked.storage_slug,
            locked.object_key
          ],
        );
        updated = (result.rows[0] as MutationImageRecord | undefined) ?? null;
        if (!updated) {
          throw new ApiError(
            409,
            "image_location_changed",
            "Image location changed before the category update was committed"
          );
        }
        await client.query("COMMIT");
        committedObjectKey = nextObjectKey;
      }
    } catch (error) {
      await client.query("ROLLBACK");
      const orphanKeys = new Set<string>();
      if (preCopiedObjectKey) orphanKeys.add(preCopiedObjectKey);
      if (copiedObjectKey) orphanKeys.add(copiedObjectKey);
      for (const key of orphanKeys) {
        const adopted = await pool
          .query("SELECT 1 FROM metadata WHERE id=$1 AND object_key=$2", [id, key])
          .then((result) => Boolean(result.rowCount))
          .catch(() => false);
        if (!adopted) {
          await removeObjectsOrEnqueueCleanup(
            id,
            [{ prefix: "media", key, backend: sourceImage.storage_slug }],
            "category_move_rollback"
          );
        }
      }
      if (preCopiedLinkThumbKey) await removeObject("link", preCopiedLinkThumbKey, sourceImage.storage_slug).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (preCopiedObjectKey && preCopiedObjectKey !== committedObjectKey) {
      await removeObjectsOrEnqueueCleanup(
        id,
        [{
          prefix: "media",
          key: preCopiedObjectKey,
          backend: sourceImage.storage_slug
        }],
        "category_move_unused_candidate"
      );
    }

    if (committedObjectKey && committedObjectKey !== sourceImage.object_key) {
      const oldThumbKey = thumbnailObjectKey(sourceImage.object_key);
      await copyObject("thumbs", oldThumbKey, "thumbs", thumbnailObjectKey(committedObjectKey), sourceImage.storage_slug).catch(() =>
        enqueue("thumb.generate", id).catch(() => undefined),
      );
      await removeObjectsOrEnqueueCleanup(
        id,
        [
          {
            prefix: "media",
            key: sourceImage.object_key,
            backend: sourceImage.storage_slug
          },
          {
            prefix: "thumbs",
            key: oldThumbKey,
            backend: sourceImage.storage_slug
          }
        ],
        "category_move_source_cleanup"
      );
    }

    if (sourceImage.is_link && updated) {
      const oldThumbKey = thumbnailRef(sourceImage).key;
      const newThumbKey = thumbnailRef(updated).key;
      if (oldThumbKey !== newThumbKey) {
        if (preCopiedLinkThumbKey !== newThumbKey) {
          await copyObject("link", oldThumbKey, "link", newThumbKey, sourceImage.storage_slug).catch(() => undefined);
          if (preCopiedLinkThumbKey) await removeObject("link", preCopiedLinkThumbKey, sourceImage.storage_slug).catch(() => undefined);
        }
        await removeObject("link", oldThumbKey, sourceImage.storage_slug).catch(() => undefined);
      }
    }

    const changedEntityKinds: EntityCacheKind[] = [];
    if (updated && sourceImage.theme !== updated.theme) changedEntityKinds.push("theme");
    if (updated && sourceImage.author !== updated.author) changedEntityKinds.push("author");
    await Promise.all([
      applyOrCollectImageMutationSync({
        id,
        md5: sourceImage.md5 ?? "",
        lookupEntries: [
          { id, object_key: sourceImage.object_key },
          { object_key: committedObjectKey },
        ],
      }, options.mutationSyncBatch),
      invalidateOrCollectEntityCountCaches(
        changedEntityKinds,
        options.entityCountInvalidationBatch,
      ),
      refreshEntityVocabularies(createdEntityKinds),
    ]);
  });

  // Theme deletion acquires the vocabulary lock before each image-location
  // lock. Explicit reassignment follows the same order, preventing the two
  // operations from deadlocking while also keeping a theme alive until the
  // metadata switch commits.
  if (parsed.theme && parsed.theme !== "none") {
    return withVocabularyMutationLock(
      "theme",
      parsed.theme,
      mutateImageLocation
    );
  }
  return mutateImageLocation();
}

type BatchStorageMigrationMetrics = {
  maxItemDurationMs: number;
  randomPoolFullRebuildTriggered: boolean;
};

type BatchStorageMigrationOptions = {
  onMetrics?: (metrics: BatchStorageMigrationMetrics) => void;
};

export async function migrateImagesStorage(
  ids: string[],
  target: string,
  options: BatchStorageMigrationOptions = {},
) {
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, is_link, device, brightness, theme, md5 FROM metadata WHERE id = ANY($1::uuid[])", [ids])).rows;
  let migrated = 0;
  let unchanged = 0;
  let failed = ids.length - rows.length;
  const migratedIds: string[] = [];
  let maxItemDurationMs = 0;
  let randomPoolFullRebuildTriggered = false;

  const concurrency = getRuntimeConfig().background_job.migrate_concurrency;
  await mapWithConcurrency(rows, concurrency, async (row) => {
    const itemStartedAt = performance.now();
    try {
      const result = await migrateImageStorage(row as MigrateRecord, target);
      if (result === "migrated") {
        migrated += 1;
        migratedIds.push(row.id);
      } else if (result === "missing") {
        failed += 1;
      } else {
        unchanged += 1;
      }
    } catch {
      failed += 1;
    } finally {
      maxItemDurationMs = Math.max(maxItemDurationMs, performance.now() - itemStartedAt);
    }
  });
  if (migratedIds.length) {
    const migratedIdSet = new Set(migratedIds);
    const randomSync = await syncRandomImages(migratedIds);
    randomPoolFullRebuildTriggered = randomSync.fullRebuildTriggered;
    await invalidateImageCaches({
      lookupEntries: rows
        .filter((row) => migratedIdSet.has(row.id))
        .map((row) => ({ id: row.id, object_key: row.object_key }))
    });
  }
  options.onMetrics?.({
    maxItemDurationMs,
    randomPoolFullRebuildTriggered,
  });
  return {
    requested: ids.length,
    migrated,
    unchanged,
    failed
  };
}
