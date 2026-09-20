import { withTransactionOnClient } from "../../core/database/transactions.ts";
import { withTrashMembershipLock } from "./membership-lock.ts";

export async function maintainTrashPurgeTasks() {
  return withTrashMembershipLock((client) => withTransactionOnClient(
    client,
    async (transaction) => {
      const result = await transaction.query(
        `WITH candidates AS MATERIALIZED (
           SELECT id, status
             FROM background_job
            WHERE type='trash.purge'
              AND ((status='failed' AND next_retry_at IS NULL)
                OR (status='succeeded' AND EXISTS (
                  SELECT 1 FROM metadata
                   WHERE metadata.id::text=background_job.target_id
                     AND metadata.status='deleted'
                )))
            FOR UPDATE
         ), retried AS (
           UPDATE background_job job
              SET status='pending', error='', retry_count=0,
                  next_retry_at=NULL, execution_token=NULL, updated_at=now()
             FROM candidates
            WHERE job.id=candidates.id
           RETURNING candidates.status
         )
         SELECT count(*) FILTER (WHERE status='failed')::int AS retried_jobs,
                count(*) FILTER (WHERE status='succeeded')::int AS repaired_jobs
           FROM retried`
      );
      return {
        retried_jobs: Number(result.rows[0]?.retried_jobs ?? 0),
        repaired_jobs: Number(result.rows[0]?.repaired_jobs ?? 0)
      };
    }
  ));
}
