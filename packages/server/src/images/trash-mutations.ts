import type {
  ImageTrashResponseDto,
  ImageRestoreResponseDto
} from "@imageshow/shared/browser";
import { withAdvisoryLocks } from "../core/database/advisory-locks.ts";
import { withTransaction } from "../core/database/transactions.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import { imageUpdateLockRequests } from "./image-update-lock.ts";
import { withImageMutationSync } from "./mutation-sync.ts";
import { decideImageMutationSync } from "./mutation-sync-policy.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";
import { lockTrashMembershipForTransaction } from "./trash-membership-lock.ts";

const moveImagesToTrashSql = `UPDATE metadata
  SET status='deleted',
      deleted_at=clock_timestamp(),
      purge_state='idle',
      purge_started_at=NULL,
      purge_error=NULL,
      updated_at=now()
  WHERE id = ANY($1::uuid[]) AND status='ready'
  RETURNING id`;

const restoreImagesSql = `UPDATE metadata
  SET status='ready', deleted_at=NULL, updated_at=now()
  WHERE id = ANY($1::uuid[])
    AND status='deleted'
    AND purge_state='idle'
  RETURNING id`;

async function mutateImageTrashState(ids: string[], sql: string) {
  const requestedCount = new Set(ids.map((id) => id.toLowerCase())).size;
  const decision = decideImageMutationSync(requestedCount);
  return withAdvisoryLocks(imageUpdateLockRequests(ids), () => (
    withImageMutationSync(async (mutationBatch) => {
      if (decision.mode === "rebuild") {
        mutationBatch.decide(decision.affectedCount);
      }
      const rows = await withTransaction(async (client) => {
        await lockTrashMembershipForTransaction(client);
        const result = await client.query(sql, [ids]);
        if (result.rowCount) await bumpReadyImageRevision(client);
        return result.rows as Array<{ id: string }>;
      });
      if (decision.mode !== "rebuild") {
        for (const row of rows) mutationBatch.add({ id: row.id });
      }
      if (rows.length) {
        await invalidateEntityCountCaches(["theme", "author"]);
      }
      return new Set(rows.map((row) => row.id.toLowerCase()));
    })
  ));
}

export async function moveImagesToTrash(
  ids: string[]
): Promise<ImageTrashResponseDto> {
  const trashedIds = await mutateImageTrashState(ids, moveImagesToTrashSql);
  return {
    requested: ids.length,
    trashed: trashedIds.size,
    ignored: ids.length - trashedIds.size,
    results: ids.map((id) => ({
      id,
      status: trashedIds.has(id.toLowerCase()) ? "trashed" : "ignored"
    }))
  };
}

export async function restoreImages(
  ids: string[]
): Promise<ImageRestoreResponseDto> {
  const restoredIds = await mutateImageTrashState(ids, restoreImagesSql);
  return {
    requested: ids.length,
    restored: restoredIds.size,
    ignored: ids.length - restoredIds.size,
    results: ids.map((id) => ({
      id,
      status: restoredIds.has(id.toLowerCase()) ? "restored" : "ignored"
    }))
  };
}
