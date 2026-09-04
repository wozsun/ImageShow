import type { PoolClient } from "pg";
import { pool } from "../core/database/pools.ts";
import { withTransactionOnClient } from "../core/database/transactions.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { withTrashMembershipLock } from "./trash-membership-lock.ts";

export type TrashPurgeTaskMaintenanceResult = {
  retried_jobs: number;
  retried_images: number;
  repaired_jobs: number;
  repaired_images: number;
};

async function createRetainedPurgeJob(
  client: PoolClient,
  jobId: string
) {
  await client.query(
    `INSERT INTO background_job(id, type, target_id, payload)
     VALUES($1, 'trash.purge', '', $2::jsonb)`,
    [jobId, JSON.stringify({ retain_exhausted: true })]
  );
}

async function retryExhaustedTrashPurgeJobs() {
  const result = await pool.query(
    `WITH retried AS (
       UPDATE background_job
          SET status='pending',
              error='',
              retry_count=0,
              next_retry_at=NULL,
              execution_token=NULL,
              updated_at=now()
        WHERE type='trash.purge'
          AND status='failed'
          AND next_retry_at IS NULL
          AND payload->>'retain_exhausted'='true'
          AND EXISTS (
            SELECT 1
              FROM metadata
             WHERE metadata.status='deleted'
               AND metadata.purge_job_id=background_job.id
          )
      RETURNING id
     )
     SELECT count(DISTINCT retried.id)::int AS jobs,
            count(metadata.id)::int AS images
       FROM retried
       LEFT JOIN metadata
         ON metadata.status='deleted'
        AND metadata.purge_job_id=retried.id`
  );
  return {
    jobs: Number(result.rows[0]?.jobs ?? 0),
    images: Number(result.rows[0]?.images ?? 0)
  };
}

async function repairTrashPurgeReferencesInTransaction(
  client: PoolClient
) {
  const targets = (await client.query(
    `SELECT metadata.id
       FROM metadata
       LEFT JOIN background_job
         ON background_job.id=metadata.purge_job_id
      WHERE metadata.status='deleted'
        AND metadata.purge_job_id IS NOT NULL
        AND (
          background_job.id IS NULL
          OR background_job.type<>'trash.purge'
          OR background_job.status='succeeded'
        )
      ORDER BY metadata.deleted_at, metadata.id
      FOR UPDATE OF metadata`
  )).rows as Array<{ id: string }>;
  if (!targets.length) {
    return {
      jobs: 0,
      images: 0
    };
  }
  const jobId = randomUuidV7();
  await createRetainedPurgeJob(client, jobId);
  const rebound = await client.query(
    `UPDATE metadata
        SET purge_job_id=$1, updated_at=now()
      WHERE id=ANY($2::uuid[])
        AND status='deleted'
      RETURNING id`,
    [jobId, targets.map((row) => row.id)]
  );
  if (rebound.rowCount !== targets.length) {
    throw new Error("Trash purge reference repair lost its locked target set");
  }
  return {
    jobs: 1,
    images: rebound.rowCount
  };
}

function repairTrashPurgeReferences() {
  return withTrashMembershipLock((client) => withTransactionOnClient(
    client,
    repairTrashPurgeReferencesInTransaction
  ));
}

export async function maintainTrashPurgeTasks(): Promise<
  TrashPurgeTaskMaintenanceResult
> {
  const repaired = await repairTrashPurgeReferences();
  const retried = await retryExhaustedTrashPurgeJobs();
  return {
    retried_jobs: retried.jobs,
    retried_images: retried.images,
    repaired_jobs: repaired.jobs,
    repaired_images: repaired.images
  };
}
