/** The durable job is the sole deletion intent, including exhausted failures. */
export const imageHasTrashPurgeJobSql = `EXISTS (
  SELECT 1 FROM background_job purge_job
   WHERE purge_job.type='trash.purge'
     AND purge_job.target_id=metadata.id::text
)`;
