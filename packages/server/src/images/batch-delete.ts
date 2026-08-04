import { withTransaction } from "../core/db.ts";
import type { BatchImageDeleteResponseDto } from "@imageshow/shared/browser";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import {
  withImageMutationSync
} from "./mutation-sync.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

export async function batchDeleteImages(
  ids: string[]
): Promise<BatchImageDeleteResponseDto> {
  if (!ids.length) return { deleted: 0, ignored: 0 };
  return withImageMutationSync(async (mutationBatch) => {
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
          RETURNING id`,
        [ids]
      );
      const targets = result.rows as Array<{ id: string }>;
      if (targets.length) await bumpReadyImageRevision(client);
      return targets;
    });
    for (const target of deletedTargets) {
      mutationBatch.add({ id: target.id });
    }
    if (deletedTargets.length) {
      await invalidateEntityCountCaches(["theme", "author"]);
    }
    return {
      deleted: deletedTargets.length,
      ignored: ids.length - deletedTargets.length
    };
  });
}
