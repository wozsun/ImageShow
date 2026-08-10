import type { Pool, PoolClient } from "pg";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { withTransaction } from "../core/database-transactions.ts";
import { ensureAuthorWithMutationLockHeld } from "../authors/mutations.ts";
import {
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies
} from "../vocab/vocab-cache.ts";
import { withVocabularyAssociationLock } from "../vocab/mutation-sync.ts";
import type {
  ImageMutationOptions,
  MetadataMutationInput,
  MutationImageRecord
} from "./metadata-mutation-contract.ts";
import { mutationImageColumns } from "./metadata-mutation-contract.ts";
import { withImageMutationSync } from "./mutation-sync.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

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
  touchAuthor: boolean
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
    [
      id,
      fields.title,
      fields.description,
      fields.source,
      fields.original,
      authorValue,
      touchAuthor
    ]
  );
  return result.rows[0] as MutationImageRecord;
}

export function updateImageFields(
  id: string,
  parsed: MetadataMutationInput,
  options: ImageMutationOptions
) {
  const touchAuthor = parsed.author !== undefined;
  const authorValue = parsed.author ? parsed.author : null;
  const applyFields = (signal?: AbortSignal) => withImageMutationSync(
    async (mutationSyncBatch) => {
      const current = (await pool.query(
        `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1`,
        [id]
      )).rows[0] as MutationImageRecord | undefined;
      if (!current) throw new ApiError(404, "not_found", "Image not found");

      const authorChanged = touchAuthor && authorValue !== current.author;
      const createdAuthor = await withTransaction(async (client) => {
        signal?.throwIfAborted();
        const created = parsed.author
          ? await ensureAuthorWithMutationLockHeld(client, parsed.author)
          : false;
        signal?.throwIfAborted();
        await applyImageFieldEdits(client, id, parsed, authorValue, touchAuthor);
        await bumpReadyImageRevision(client);
        return created;
      });
      mutationSyncBatch.add({ id });
      const cacheTasks: Array<Promise<unknown>> = [];
      if (authorChanged) {
        cacheTasks.push(invalidateOrCollectEntityCountCaches(
          ["author"],
          options.entityCountInvalidationBatch
        ));
      }
      if (createdAuthor) {
        cacheTasks.push(refreshEntityVocabularies(["author"]));
      }
      await Promise.all(cacheTasks);
    }
  );
  return parsed.author
    ? withVocabularyAssociationLock("author", parsed.author, applyFields)
    : applyFields();
}
