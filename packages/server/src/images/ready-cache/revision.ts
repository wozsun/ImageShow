import type { PoolClient } from "pg";
import { pool } from "../../core/database/pools.ts";

type ReadyImageRevisionReader = {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

export type ReadyImageRevision = string;

export type ReadyImageRevisionSnapshot = {
  revision: ReadyImageRevision;
  updatedAt: string;
};

function parseRevision(value: unknown): ReadyImageRevision {
  const revision = String(value ?? "");
  if (!/^\d+$/.test(revision) || BigInt(revision) < 0n) {
    throw new Error("PostgreSQL returned an invalid ready-image revision");
  }
  return revision;
}

function revisionSnapshot(row: Record<string, unknown> | undefined) {
  if (!row) throw new Error("ready_image_revision singleton is missing");
  const updatedAt = row.updated_at instanceof Date
    ? row.updated_at.toISOString()
    : String(row.updated_at ?? "");
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("PostgreSQL returned an invalid ready-image revision timestamp");
  }
  return {
    revision: parseRevision(row.revision),
    updatedAt
  } satisfies ReadyImageRevisionSnapshot;
}

export async function getReadyImageRevision(
  client: ReadyImageRevisionReader = pool
): Promise<ReadyImageRevisionSnapshot> {
  const row = (await client.query(
    `SELECT revision, updated_at
       FROM ready_image_revision
      WHERE singleton=1`
  )).rows[0] as Record<string, unknown> | undefined;
  return revisionSnapshot(row);
}

/**
 * Increment the cache revision at most once in the current PostgreSQL
 * transaction. The transaction-local marker rolls back with a savepoint or
 * the surrounding transaction and disappears after COMMIT.
 */
export async function bumpReadyImageRevision(
  client: PoolClient
): Promise<ReadyImageRevisionSnapshot> {
  const row = (await client.query(
    `WITH marker AS (
       SELECT set_config(
         'imageshow.ready_image_revision_bumped',
         '1',
         true
       )
       WHERE current_setting(
         'imageshow.ready_image_revision_bumped',
         true
       ) IS DISTINCT FROM '1'
     ), updated AS (
       UPDATE ready_image_revision
          SET revision=revision+1,
              updated_at=clock_timestamp()
        WHERE singleton=1
          AND EXISTS (SELECT 1 FROM marker)
       RETURNING revision, updated_at
     )
     SELECT revision, updated_at FROM updated
     UNION ALL
     SELECT revision, updated_at
       FROM ready_image_revision
      WHERE singleton=1
        AND NOT EXISTS (SELECT 1 FROM updated)
     LIMIT 1`
  )).rows[0] as Record<string, unknown> | undefined;
  return revisionSnapshot(row);
}

export function compareReadyImageRevisions(
  left: ReadyImageRevision,
  right: ReadyImageRevision
) {
  const leftValue = BigInt(parseRevision(left));
  const rightValue = BigInt(parseRevision(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
