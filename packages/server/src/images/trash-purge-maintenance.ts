import type {
  TrashPurgeMaintenanceRequestDto,
  TrashPurgeMaintenanceResponseDto
} from "@imageshow/shared/browser";
import type { PoolClient } from "pg";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database/pools.ts";
import { withTransactionOnClient } from "../core/database/transactions.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { withTrashMembershipLock } from "./trash-membership-lock.ts";

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

async function retryTrashPurgeJob(
  jobId: string
): Promise<TrashPurgeMaintenanceResponseDto> {
  const result = await pool.query(
    `UPDATE background_job
        SET status='pending',
            error='',
            retry_count=0,
            next_retry_at=NULL,
            execution_token=NULL,
            updated_at=now()
      WHERE id=$1
        AND type='trash.purge'
        AND status='failed'
        AND next_retry_at IS NULL
        AND payload->>'retain_exhausted'='true'
        AND EXISTS (
          SELECT 1
            FROM metadata
           WHERE metadata.status='deleted'
             AND metadata.purge_job_id=background_job.id
        )
      RETURNING id`,
    [jobId]
  );
  if (!result.rowCount) {
    throw new ApiError(
      409,
      "trash_purge_state_changed",
      "Trash purge job is no longer an exhausted retained job"
    );
  }
  const images = await pool.query(
    `SELECT count(*)::int AS count
       FROM metadata
      WHERE status='deleted' AND purge_job_id=$1`,
    [jobId]
  );
  return {
    action: "retry",
    affected_jobs: 1,
    affected_images: Number(images.rows[0]?.count ?? 0),
    skipped_jobs: 0
  };
}

async function repairTrashPurgeReferencesInTransaction(
  client: PoolClient
): Promise<TrashPurgeMaintenanceResponseDto> {
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
      action: "repair",
      affected_jobs: 0,
      affected_images: 0,
      skipped_jobs: 0
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
    action: "repair",
    affected_jobs: 1,
    affected_images: rebound.rowCount,
    skipped_jobs: 0
  };
}

function repairTrashPurgeReferences() {
  return withTrashMembershipLock((client) => withTransactionOnClient(
    client,
    repairTrashPurgeReferencesInTransaction
  ));
}

export function maintainTrashPurge(
  request: TrashPurgeMaintenanceRequestDto
): Promise<TrashPurgeMaintenanceResponseDto> {
  switch (request.action) {
    case "retry":
      return retryTrashPurgeJob(request.job_id);
    case "repair":
      return repairTrashPurgeReferences();
  }
}
