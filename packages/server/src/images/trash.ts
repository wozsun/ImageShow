import { appConfig } from "@imageshow/shared";
import { pool, withTransaction } from "../core/db.ts";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { resolveStorageAccess } from "../storage/backend-registry.ts";
import { thumbnailRef } from "../storage/image-paths.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import { restoreImageFromTrash, restoreImagesFromTrash } from "./restore.ts";
import {
  invalidateImageCaches
} from "./image-cache.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import { syncRandomImage } from "../random/cache-sync.ts";

type PurgeRow = {
  id: string;
  object_key: string;
  md5: string;
  storage_slug: string;
  purge_attempts: number;
};

const purgeReturnColumns = [
  "metadata.id",
  "metadata.object_key",
  "metadata.md5",
  "metadata.storage_slug",
  "metadata.purge_attempts"
].join(", ");

export async function moveImageToTrash(id: string) {
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
    if (!result.rowCount) {
      throw new ApiError(404, "not_found", "Ready image not found");
    }
    return result.rows[0] as {
      id: string;
      object_key: string;
      md5: string | null;
    };
  });
  await syncRandomImage(deleted.id);
  await Promise.all([
    invalidateImageCaches({
      lookupEntries: [deleted],
      md5s: [deleted.md5 ?? ""]
    }),
    invalidateEntityCountCaches(["theme", "author"])
  ]);
}

export async function restoreDeletedImage(id: string, missingIsError = true) {
  const result = await restoreImageFromTrash(id);
  if (result.status === "not_deleted") {
    if (missingIsError) {
      const state = (await pool.query(
        "SELECT status, purge_state FROM metadata WHERE id=$1",
        [id]
      )).rows[0] as { status: string; purge_state: string } | undefined;
      if (state?.status === "deleted" && state.purge_state !== "idle") {
        throw new ApiError(
          409,
          "image_purge_claimed",
          "Image is already owned by permanent deletion and cannot be restored"
        );
      }
      throw new ApiError(404, "not_found", "Deleted image not found");
    }
    return false;
  }
  await Promise.all([
    invalidateImageCaches({
      lookupEntries: [result.image],
      md5s: [result.image.md5 ?? ""]
    }),
    invalidateEntityCountCaches(["theme", "author"])
  ]);
  return true;
}

export async function batchRestoreImages(ids: string[]) {
  const restoredImages = await restoreImagesFromTrash(ids);
  if (restoredImages.length) {
    await Promise.all([
      invalidateImageCaches({
        lookupEntries: restoredImages,
        md5s: restoredImages.map((image) => image.md5 ?? "")
      }),
      invalidateEntityCountCaches(["theme", "author"])
    ]);
  }
  return {
    restored: restoredImages.length,
    ignored: ids.length - restoredImages.length
  };
}

async function claimPurgeRows(ids?: string[]) {
  if (ids && !ids.length) return [];
  const params: unknown[] = [];
  const idPredicate = ids
    ? `AND id = ANY($${params.push(ids)}::uuid[])`
    : "";
  const limitParameter = params.push(
    Math.min(appConfig.trashBatchSize, ids?.length ?? appConfig.trashBatchSize)
  );
  return (await pool.query(
    `WITH candidates AS (
       SELECT id
         FROM metadata
        WHERE status='deleted'
          AND (
            purge_state IN ('idle', 'failed')
            OR (
              purge_state='purging'
              AND purge_started_at < now() - interval '15 minutes'
            )
          )
          ${idPredicate}
        ORDER BY deleted_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $${limitParameter}
     )
     UPDATE metadata
        SET purge_state='purging',
            purge_started_at=now(),
            purge_attempts=purge_attempts + 1,
            purge_error=NULL,
            updated_at=now()
       FROM candidates
      WHERE metadata.id=candidates.id
      RETURNING ${purgeReturnColumns}`,
    params
  )).rows as PurgeRow[];
}

async function countRemainingPurgeRows(ids?: string[]) {
  if (ids && !ids.length) return 0;
  const result = ids
    ? await pool.query(
        "SELECT count(*)::int AS count FROM metadata WHERE status='deleted' AND id = ANY($1::uuid[])",
        [ids]
      )
    : await pool.query(
        "SELECT count(*)::int AS count FROM metadata WHERE status='deleted'"
      );
  return Number(result.rows[0]?.count ?? 0);
}

async function markPurgeFailed(row: PurgeRow, error: unknown) {
  const message = errorMessage(error).slice(0, 2_000);
  await pool.query(
    `UPDATE metadata
        SET purge_state='failed', purge_error=$2, updated_at=now()
      WHERE id=$1
        AND status='deleted'
        AND purge_state='purging'
        AND purge_attempts=$3`,
    [row.id, message, row.purge_attempts]
  );
}

async function purgeClaimedRow(claim: PurgeRow): Promise<PurgeRow | null> {
  return withImageStorageMutationLock(claim.id, async (signal) => {
    signal.throwIfAborted();
    // A storage migration or theme reassignment may have completed while this
    // purge waited for the per-image location lock. Always delete from the
    // current location owned by this exact purge attempt, never from the claim
    // snapshot.
    const row = (await pool.query(
      `SELECT ${purgeReturnColumns}
         FROM metadata
        WHERE id=$1
          AND status='deleted'
          AND purge_state='purging'
          AND purge_attempts=$2`,
      [claim.id, claim.purge_attempts]
    )).rows[0] as PurgeRow | undefined;
    signal.throwIfAborted();
    if (!row) return null;

    const thumb = thumbnailRef(row);
    const storage = await resolveStorageAccess(row.storage_slug);
    signal.throwIfAborted();
    const removals = await Promise.allSettled([
      storage.driver.remove(thumb.prefix, thumb.key),
      storage.driver.remove("media", row.object_key)
    ]);
    const removalErrors = removals.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (removalErrors.length) {
      throw new AggregateError(removalErrors, "Failed to remove all image objects");
    }
    signal.throwIfAborted();

    const deleted = await pool.query(
      `DELETE FROM metadata
        WHERE id=$1
          AND status='deleted'
          AND purge_state='purging'
          AND purge_attempts=$2
          AND storage_slug=$3
          AND object_key=$4
        RETURNING id`,
      [row.id, row.purge_attempts, row.storage_slug, row.object_key]
    );
    signal.throwIfAborted();
    return deleted.rowCount ? row : null;
  });
}

export async function purgeDeletedImages(ids?: string[]) {
  const rows = await claimPurgeRows(ids);
  const deletedRows: PurgeRow[] = [];
  let failed = 0;

  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(rows.slice(offset, offset + 10).map(async (row) => {
      try {
        const deleted = await purgeClaimedRow(row);
        if (deleted) deletedRows.push(deleted);
        else {
          failed += 1;
          await markPurgeFailed(
            row,
            new Error("Purge ownership was lost before metadata deletion")
          ).catch(() => undefined);
        }
      } catch (error) {
        failed += 1;
        await markPurgeFailed(row, error).catch(() => undefined);
      }
    }));
  }

  if (deletedRows.length) {
    await Promise.all([
      invalidateImageCaches({
        lookupEntries: deletedRows,
        md5s: deletedRows.map((row) => row.md5)
      }),
      invalidateEntityCountCaches(["tag"])
    ]);
  }
  return {
    requested: rows.length,
    deleted: deletedRows.length,
    failed,
    remaining: await countRemainingPurgeRows(ids)
  };
}

export async function purgeDeletedImage(id: string) {
  const result = await purgeDeletedImages([id]);
  if (!result.requested) {
    const state = (await pool.query(
      "SELECT status, purge_state FROM metadata WHERE id=$1",
      [id]
    )).rows[0] as { status: string; purge_state: string } | undefined;
    if (state?.status === "deleted") {
      throw new ApiError(
        409,
        "image_purge_in_progress",
        "Image is already being permanently deleted"
      );
    }
    throw new ApiError(404, "not_found", "Deleted image not found");
  }
  if (result.failed) {
    throw new ApiError(
      502,
      "storage_delete_failed",
      "Failed to permanently delete the stored image"
    );
  }
}
