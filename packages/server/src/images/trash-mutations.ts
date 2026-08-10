import type {
  BatchImageDeleteResponseDto,
  BatchImageRestoreResponseDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { withTransaction } from "../core/database-transactions.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import { withImageMutationSync } from "./mutation-sync.ts";
import { decideImageMutationSync } from "./mutation-sync-policy.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

type RestoredImage = { id: string };

type RestoreImagesResult = {
  restored: number;
  images: RestoredImage[];
};

type RestoreResult =
  | { status: "restored"; image: RestoredImage }
  | { status: "not_deleted" };

async function restoreImageFromTrash(id: string): Promise<RestoreResult> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE metadata
          SET status='ready', deleted_at=NULL, updated_at=now()
        WHERE id=$1 AND status='deleted' AND purge_state='idle'
        RETURNING id`,
      [id]
    );
    const image = result.rows[0] as RestoredImage | undefined;
    if (!image) return { status: "not_deleted" };
    await bumpReadyImageRevision(client);
    return { status: "restored", image };
  });
}

async function restoreImagesFromTrash(
  ids: string[],
  options: { returnIds?: boolean } = {}
): Promise<RestoreImagesResult> {
  if (!ids.length) return { restored: 0, images: [] };
  const returnIds = options.returnIds !== false;
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE metadata
          SET status='ready', deleted_at=NULL, updated_at=now()
        WHERE id = ANY($1::uuid[]) AND status='deleted' AND purge_state='idle'
        ${returnIds ? "RETURNING id" : ""}`,
      [ids]
    );
    const images = result.rows as RestoredImage[];
    const restored = Number(result.rowCount ?? 0);
    if (restored) await bumpReadyImageRevision(client);
    return { restored, images };
  });
}

export async function moveImageToTrash(id: string) {
  return withImageMutationSync(async (mutationBatch) => {
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
          RETURNING id`,
        [id]
      );
      if (!result.rowCount) {
        throw new ApiError(404, "not_found", "Ready image not found");
      }
      await bumpReadyImageRevision(client);
      return result.rows[0] as { id: string };
    });
    mutationBatch.add({ id: deleted.id });
    await invalidateEntityCountCaches(["theme", "author"]);
  });
}

export async function batchDeleteImages(
  ids: string[]
): Promise<BatchImageDeleteResponseDto> {
  if (!ids.length) return { deleted: 0, ignored: 0 };
  const requestedCount = new Set(ids.map((id) => id.toLowerCase())).size;
  const decision = decideImageMutationSync(requestedCount);
  return withImageMutationSync(async (mutationBatch) => {
    if (decision.mode === "rebuild") {
      mutationBatch.decide(decision.affectedCount);
    }
    const deletedTargets = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE metadata
            SET status='deleted',
                deleted_at=now(),
                purge_state='idle',
                purge_started_at=NULL,
                purge_error=NULL,
                updated_at=now()
          WHERE id = ANY($1::uuid[]) AND status='ready'
          ${decision.mode === "rebuild" ? "" : "RETURNING id"}`,
        [ids]
      );
      const targets = result.rows as Array<{ id: string }>;
      const deleted = Number(result.rowCount ?? 0);
      if (deleted) await bumpReadyImageRevision(client);
      return { deleted, targets };
    });
    for (const target of deletedTargets.targets) {
      mutationBatch.add({ id: target.id });
    }
    if (deletedTargets.deleted) {
      await invalidateEntityCountCaches(["theme", "author"]);
    }
    return {
      deleted: deletedTargets.deleted,
      ignored: ids.length - deletedTargets.deleted
    };
  });
}

export async function restoreDeletedImage(id: string, missingIsError = true) {
  return withImageMutationSync(async (mutationBatch) => {
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
    mutationBatch.add({ id: result.image.id });
    await invalidateEntityCountCaches(["theme", "author"]);
    return true;
  });
}

export async function batchRestoreImages(
  ids: string[]
): Promise<BatchImageRestoreResponseDto> {
  const requestedCount = new Set(ids.map((id) => id.toLowerCase())).size;
  const decision = decideImageMutationSync(requestedCount);
  return withImageMutationSync(async (mutationBatch) => {
    if (decision.mode === "rebuild") {
      mutationBatch.decide(decision.affectedCount);
    }
    const result = await restoreImagesFromTrash(ids, {
      returnIds: decision.mode !== "rebuild"
    });
    for (const image of result.images) {
      mutationBatch.add({ id: image.id });
    }
    if (result.restored) {
      await invalidateEntityCountCaches(["theme", "author"]);
    }
    return {
      restored: result.restored,
      ignored: ids.length - result.restored
    };
  });
}
