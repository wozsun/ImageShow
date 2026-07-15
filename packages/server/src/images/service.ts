import type { Pool, PoolClient } from "pg";
import { pool, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithConcurrency } from "../core/concurrency.ts";
import { metadataUpdateInput, parse } from "../core/validation.ts";
import { invalidateImageLookupEntries, invalidateImageReadCaches, invalidateMd5Cache } from "./image-cache.ts";
import { syncRandomImage, syncRandomImages } from "../random/random-cache.ts";
import { enqueue } from "../jobs/repository.ts";
import { storageObjectKey, thumbnailObjectKey, thumbnailRef } from "../storage/image-paths.ts";
import { copyObject, exists, readStorageBuffer, removeObject } from "../storage/storage.ts";
import { migrateImageStorage, type MigrateRecord } from "../storage/migration.ts";
import { withStorageMutationLock } from "../storage/maintenance-lock.ts";
import { isReservedSubdomain } from "../themes/host.ts";
import { ensureTheme } from "../themes/service.ts";
import { ensureAuthor } from "../authors/service.ts";
import {
  invalidateEntityCountCaches,
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind,
  type EntityCountCacheInvalidationBatch,
} from "../vocab/vocab-cache.ts";
import { detectBrightness } from "./brightness.ts";
import { deviceFromDimensions, resolveOptionalBrightnessWith, resolveOptionalDeviceWith } from "./classification.ts";
import { publicImage, type ImageRecord } from "./presenter.ts";
import {
  applyOrCollectImageMutationSync,
  type ImageMutationSyncBatch,
} from "./mutation-sync.ts";

async function detectImageBrightness(image: ImageRecord) {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef(image);
  if (!(await exists(thumb.prefix, thumb.key, thumb.slug))) return undefined;
  return detectBrightness(await readStorageBuffer(thumb.prefix, thumb.key, thumb.slug));
}

function detectImageDevice(image: ImageRecord) {
  if (image.status !== "ready") return undefined;
  return deviceFromDimensions(image.width, image.height);
}

type ImageMutationOptions = {
  entityCountInvalidationBatch?: EntityCountCacheInvalidationBatch;
  mutationSyncBatch?: ImageMutationSyncBatch;
  presentResult?: boolean;
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
): Promise<ImageRecord> {
  const result = await executor.query(
    "UPDATE metadata SET title=COALESCE($2,title), description=COALESCE($3,description), source=COALESCE($4,source), original=COALESCE($5,original), author=CASE WHEN $7::boolean THEN $6 ELSE author END, updated_at=now() WHERE id=$1 RETURNING *",
    [id, fields.title, fields.description, fields.source, fields.original, authorValue, touchAuthor],
  );
  return result.rows[0] as ImageRecord;
}

export async function deleteImage(id: string) {
  const deleted = await withTransaction(async (client) => {
    const result = await client.query("UPDATE metadata SET status='deleted', deleted_at=now(), updated_at=now() WHERE id=$1 AND status='ready' RETURNING id, object_key, md5", [id]);
    if (!result.rowCount) throw new ApiError(404, "not_found", "Ready image not found");
    return result.rows[0] as { id: string; object_key: string; md5: string | null };
  });
  await syncRandomImage(deleted.id);
  await invalidateMd5Cache(deleted.md5 ?? "");
  await invalidateImageLookupEntries([deleted]);
  await Promise.all([
    invalidateImageReadCaches(),
    invalidateEntityCountCaches(["theme", "author"]),
  ]);
}

export async function updateImageMetadata(id: string, body: unknown, options: ImageMutationOptions = {}) {
  const current = (await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord | undefined;
  if (!current) throw new ApiError(404, "not_found", "Image not found");

  const parsed = parse(metadataUpdateInput, body);
  if (parsed.theme && isReservedSubdomain(parsed.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: parsed.theme });

  const next = {
    ...parsed,
    device: resolveOptionalDeviceWith(parsed.device, () => detectImageDevice(current)),
    brightness: await resolveOptionalBrightnessWith(parsed.brightness, () => detectImageBrightness(current)),
  };
  const touchAuthor = next.author !== undefined;
  const authorValue = next.author ? next.author : null;
  const targetDevice = next.device ?? current.device;
  const targetBrightness = next.brightness ?? current.brightness;
  const targetTheme = next.theme ?? current.theme;
  const classificationChanged = targetDevice !== current.device || targetBrightness !== current.brightness || targetTheme !== current.theme;
  const authorChanged = touchAuthor && authorValue !== current.author;

  if (!classificationChanged) {
    const createdAuthor = next.author ? await ensureAuthor(pool, next.author) : false;
    const updated = await applyImageFieldEdits(pool, id, next, authorValue, touchAuthor);
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
    return (options.presentResult ?? true) ? publicImage(updated) : undefined;
  }

  return withStorageMutationLock(async () => {
    if (current.status !== "ready") throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
    const sourceIsLink = Boolean(current.is_link);
    const sourceSlug = current.storage_slug;
    const predictedKey = sourceIsLink ? current.object_key : storageObjectKey(targetDevice, targetBrightness, targetTheme, id, current.ext);
    let preCopiedObjectKey = "";
    let preCopiedLinkThumbKey = "";

    if (!sourceIsLink && predictedKey !== current.object_key) {
      await copyObject("media", current.object_key, "media", predictedKey, sourceSlug);
      preCopiedObjectKey = predictedKey;
    }

    if (sourceIsLink) {
      const oldThumb = thumbnailRef({
        ...current,
        storage_slug: sourceSlug,
        is_link: true,
      });
      const newThumb = thumbnailRef({
        ...current,
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
    let sourceImage = current;
    let updated: ImageRecord | null = null;
    let committedObjectKey = "";
    let copiedObjectKey = "";
    const createdEntityKinds = new Set<EntityCacheKind>();
    try {
      await client.query("BEGIN");
      const locked = (await client.query("SELECT * FROM metadata WHERE id=$1 FOR UPDATE", [id])).rows[0] as ImageRecord | undefined;
      if (!locked) throw new ApiError(404, "not_found", "Image not found");
      if (locked.status !== "ready") throw new ApiError(409, "invalid_image_state", "Only ready images can change category");
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
        if (await ensureTheme(client, theme)) createdEntityKinds.add("theme");
        if (next.author && await ensureAuthor(client, next.author)) createdEntityKinds.add("author");

        if (!isLink && nextObjectKey !== locked.object_key) {
          if (preCopiedObjectKey !== nextObjectKey) {
            await copyObject("media", locked.object_key, "media", nextObjectKey, locked.storage_slug);
            copiedObjectKey = nextObjectKey;
          }
        }

        const result = await client.query(
          "UPDATE metadata SET device=$2, brightness=$3, theme=$4, object_key=$5, title=COALESCE($6,title), description=COALESCE($7,description), source=COALESCE($8,source), original=COALESCE($9,original), author=CASE WHEN $11::boolean THEN $10 ELSE author END, updated_at=now() WHERE id=$1 RETURNING *",
          [id, device, brightness, theme, nextObjectKey, next.title, next.description, next.source, next.original, authorValue, touchAuthor],
        );
        updated = result.rows[0] as ImageRecord;
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
          await removeObject("media", key, sourceImage.storage_slug).catch(() =>
            enqueue("move.cleanup", id, { object_key: key, backend: sourceImage.storage_slug }, `move.cleanup:${id}:${key}`).catch(() => undefined),
          );
        }
      }
      if (preCopiedLinkThumbKey) await removeObject("link", preCopiedLinkThumbKey, sourceImage.storage_slug).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (preCopiedObjectKey && preCopiedObjectKey !== committedObjectKey) {
      await removeObject("media", preCopiedObjectKey, sourceImage.storage_slug).catch(() =>
        enqueue("move.cleanup", id, { object_key: preCopiedObjectKey, backend: sourceImage.storage_slug }, `move.cleanup:${id}:${preCopiedObjectKey}`).catch(() => undefined),
      );
    }

    if (committedObjectKey && committedObjectKey !== sourceImage.object_key) {
      const oldThumbKey = thumbnailObjectKey(sourceImage.object_key);
      await copyObject("thumbs", oldThumbKey, "thumbs", thumbnailObjectKey(committedObjectKey), sourceImage.storage_slug).catch(() =>
        enqueue("thumb.generate", id).catch(() => undefined),
      );
      await Promise.all([removeObject("media", sourceImage.object_key, sourceImage.storage_slug), removeObject("thumbs", oldThumbKey, sourceImage.storage_slug)]).catch(() =>
        enqueue(
          "move.cleanup",
          id,
          {
            object_key: sourceImage.object_key,
            backend: sourceImage.storage_slug,
          },
          `move.cleanup:${id}:${sourceImage.object_key}`,
        ).catch(() => undefined),
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
    if (!(options.presentResult ?? true)) return undefined;
    return publicImage(updated ?? ((await pool.query("SELECT * FROM metadata WHERE id=$1", [id])).rows[0] as ImageRecord));
  });
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
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, is_link, device, brightness, theme FROM metadata WHERE id = ANY($1::uuid[])", [ids])).rows;
  const foundIds = new Set(rows.map((row) => String(row.id)));
  const missingIds = ids.filter((id) => !foundIds.has(id));
  let migrated = 0;
  let unchanged = 0;
  let failed = missingIds.length;
  const failedIds: string[] = [...missingIds];
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
        failedIds.push(row.id);
      } else {
        unchanged += 1;
      }
    } catch {
      failed += 1;
      failedIds.push(row.id);
    } finally {
      maxItemDurationMs = Math.max(maxItemDurationMs, performance.now() - itemStartedAt);
    }
  });
  if (migratedIds.length) {
    const migratedIdSet = new Set(migratedIds);
    const randomSync = await syncRandomImages(migratedIds);
    randomPoolFullRebuildTriggered = randomSync.fullRebuildTriggered;
    await invalidateImageLookupEntries(rows
      .filter((row) => migratedIdSet.has(row.id))
      .map((row) => ({ id: row.id, object_key: row.object_key })));
    await invalidateImageReadCaches();
  }
  options.onMetrics?.({
    maxItemDurationMs,
    randomPoolFullRebuildTriggered,
  });
  return {
    requested: ids.length,
    migrated,
    unchanged,
    failed,
    failed_ids: failedIds,
  };
}
