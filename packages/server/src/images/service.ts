import type { Pool, PoolClient } from "pg";
import { pool, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithConcurrency } from "../core/concurrency.ts";
import { metadataUpdateInput, parse } from "../core/validation.ts";
import { invalidateImageCaches } from "./image-cache.ts";
import { syncRandomImage, syncRandomImages } from "../random/random-cache.ts";
import { thumbnailRef } from "../storage/image-paths.ts";
import { exists, readStorageBuffer } from "../storage/storage.ts";
import { migrateImageStorage, type MigrateRecord } from "../storage/migration.ts";
import {
  imageStorageMutationLockKey,
  withImageStorageMutationLock,
  withStorageLocationReadAndAdvisoryLocks
} from "../storage/maintenance-lock.ts";
import {
  completePreparedImageRelocation,
  discardPreparedImageRelocationIfUnreferenced,
  prepareVerifiedImageRelocation
} from "../storage/image-relocation.ts";
import { isReservedSubdomain } from "../themes/host.ts";
import {
  ensureThemeWithMutationLockHeld
} from "../themes/service.ts";
import {
  ensureAuthor,
  ensureAuthorWithMutationLockHeld
} from "../authors/service.ts";
import {
  invalidateEntityCountCaches,
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind,
  type EntityCountCacheInvalidationBatch,
} from "../vocab/vocab-cache.ts";
import { vocabularyMutationLockRequests } from "../vocab/mutation-sync.ts";
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

  const mutateImageLocation = async () => {
    // Derive omitted fields only after owning the image location. This keeps a
    // concurrent storage migration from being overwritten by an old snapshot.
    const sourceImage = (await pool.query(
      `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1`,
      [id]
    )).rows[0] as MutationImageRecord | undefined;
    if (!sourceImage) throw new ApiError(404, "not_found", "Image not found");
    if (sourceImage.status !== "ready") {
      throw new ApiError(
        409,
        "invalid_image_state",
        "Only ready images can change category"
      );
    }

    const next = {
      ...parsed,
      device: resolveOptionalDeviceWith(
        parsed.device,
        () => detectImageDevice(sourceImage)
      ),
      brightness: await resolveOptionalBrightnessWith(
        parsed.brightness,
        () => detectImageBrightness(sourceImage)
      )
    };
    const target = {
      device: next.device ?? sourceImage.device,
      brightness: next.brightness ?? sourceImage.brightness,
      theme: next.theme ?? sourceImage.theme
    };
    const classificationChanged = target.device !== sourceImage.device
      || target.brightness !== sourceImage.brightness
      || target.theme !== sourceImage.theme;
    const relocation = classificationChanged
      ? await prepareVerifiedImageRelocation(sourceImage, target, "category_move")
      : null;
    const createdEntityKinds = new Set<EntityCacheKind>();
    const client = await pool.connect();
    let updated: MutationImageRecord;

    try {
      await client.query("BEGIN");
      const locked = (await client.query(
        `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1 FOR UPDATE`,
        [id]
      )).rows[0] as MutationImageRecord | undefined;
      if (!locked) throw new ApiError(404, "not_found", "Image not found");
      if (locked.status !== "ready") {
        throw new ApiError(
          409,
          "invalid_image_state",
          "Only ready images can change category"
        );
      }
      if (
        locked.storage_slug !== sourceImage.storage_slug
        || locked.object_key !== sourceImage.object_key
        || locked.device !== sourceImage.device
        || locked.brightness !== sourceImage.brightness
        || locked.theme !== sourceImage.theme
      ) {
        throw new ApiError(
          409,
          "image_location_changed",
          "Image location changed while preparing the category update"
        );
      }

      if (
        parsed.theme
        && parsed.theme !== "none"
        && await ensureThemeWithMutationLockHeld(client, target.theme)
      ) {
        createdEntityKinds.add("theme");
      }
      if (
        next.author
        && await ensureAuthorWithMutationLockHeld(client, next.author)
      ) {
        createdEntityKinds.add("author");
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
          WHERE id=$1
            AND storage_slug=$12
            AND object_key=$13
            AND device=$14
            AND brightness=$15
            AND theme=$16
          RETURNING ${mutationImageColumns}`,
        [
          id,
          target.device,
          target.brightness,
          target.theme,
          relocation?.nextObjectKey ?? locked.object_key,
          next.title,
          next.description,
          next.source,
          next.original,
          authorValue,
          touchAuthor,
          sourceImage.storage_slug,
          sourceImage.object_key,
          sourceImage.device,
          sourceImage.brightness,
          sourceImage.theme
        ]
      );
      const updatedRow = result.rows[0] as MutationImageRecord | undefined;
      if (!updatedRow) {
        throw new ApiError(
          409,
          "image_location_changed",
          "Image location changed before the category update was committed"
        );
      }
      updated = updatedRow;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (relocation) {
        await discardPreparedImageRelocationIfUnreferenced(
          relocation,
          "category_move_compare_and_swap_failed"
        );
      }
      throw error;
    } finally {
      client.release();
    }

    if (relocation) {
      await completePreparedImageRelocation(
        relocation,
        "category_move_source_cleanup"
      );
    }

    const changedEntityKinds: EntityCacheKind[] = [];
    if (sourceImage.theme !== updated.theme) changedEntityKinds.push("theme");
    if (sourceImage.author !== updated.author) changedEntityKinds.push("author");
    await Promise.all([
      applyOrCollectImageMutationSync({
        id,
        md5: sourceImage.md5 ?? "",
        lookupEntries: [
          { id, object_key: sourceImage.object_key },
          { object_key: updated.object_key }
        ]
      }, options.mutationSyncBatch),
      invalidateOrCollectEntityCountCaches(
        changedEntityKinds,
        options.entityCountInvalidationBatch
      ),
      refreshEntityVocabularies(createdEntityKinds)
    ]);
  };

  const vocabularyLocks = vocabularyMutationLockRequests([
    ...(parsed.author
      ? [{ entity: "author" as const, slug: parsed.author }]
      : []),
    ...(parsed.theme && parsed.theme !== "none"
      ? [{ entity: "theme" as const, slug: parsed.theme }]
      : [])
  ]);
  if (vocabularyLocks.length) {
    return withStorageLocationReadAndAdvisoryLocks(
      [...vocabularyLocks, { key: imageStorageMutationLockKey(id) }],
      mutateImageLocation
    );
  }
  return withImageStorageMutationLock(id, mutateImageLocation);
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
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, device, brightness, theme, md5 FROM metadata WHERE id = ANY($1::uuid[])", [ids])).rows;
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
