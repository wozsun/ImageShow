import type { PoolClient } from "pg";
import { appConfig } from "@imageshow/shared";
import { randomUuidV7 } from "../uuid.ts";

/** Temporary 6.4.3 -> 6.4.4 startup conversion; remove with its caller in 6.4.5. */
export async function upgradeTrashPurgeFor644(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "imageshow:upgrade:6.4.4"
  ]);
  const column = (await client.query<{ type: string }>(
    `SELECT atttypid::regtype::text AS type FROM pg_attribute
      WHERE attrelid=to_regclass('public.metadata')
        AND attname='purge_job_id' AND NOT attisdropped`
  )).rows[0];
  if (!column) return null;
  if (column.type !== "uuid") {
    throw new Error("6.4.4 upgrade requires a UUID metadata.purge_job_id");
  }
  // The caller owns the startup transaction; no HTTP server or worker runs yet.
  await client.query("LOCK TABLE public.metadata, public.background_job IN ACCESS EXCLUSIVE MODE");
  const invalid = (await client.query(
    `SELECT count(*)::int AS count FROM metadata
       LEFT JOIN background_job ON background_job.id=metadata.purge_job_id
      WHERE metadata.purge_job_id IS NOT NULL
        AND (metadata.status<>'deleted' OR background_job.id IS NULL
          OR background_job.type<>'trash.purge' OR background_job.status='succeeded')`
  )).rows[0];
  if (Number(invalid?.count)) {
    throw new Error("6.4.4 upgrade found invalid purge references; repair them with the previous version before upgrading");
  }
  const metadataCount = (await client.query("SELECT count(*)::text AS count FROM metadata")).rows[0]?.count;
  await client.query(
    `CREATE TEMP TABLE imageshow_purge_upgrade_members ON COMMIT DROP AS
     SELECT metadata.id AS image_id, job.id AS source_job_id,
            NULL::uuid AS new_job_id,
            row_number() OVER (PARTITION BY job.id ORDER BY metadata.deleted_at, metadata.id) AS member_order,
            CASE WHEN job.status='running' THEN 'failed' ELSE job.status END AS status,
            job.retry_count + CASE WHEN job.status='running' THEN 1 ELSE 0 END AS retry_count,
            CASE WHEN job.status='running' THEN
              CASE WHEN job.retry_count + 1 >= $1 THEN NULL ELSE now() END
              ELSE job.next_retry_at END AS next_retry_at,
            CASE WHEN job.status='running' THEN 'Recovered running task during 6.4.4 upgrade'
              ELSE job.error END AS error,
            job.created_at,
            CASE WHEN job.status='running' THEN now() ELSE job.updated_at END AS updated_at
       FROM metadata JOIN background_job job ON job.id=metadata.purge_job_id`,
    [appConfig.backgroundJob.maxRetries]
  );
  await client.query(
    "UPDATE imageshow_purge_upgrade_members SET new_job_id=source_job_id WHERE member_order=1"
  );
  while (true) {
    const batch = (await client.query<{ image_id: string }>(
      `SELECT image_id FROM imageshow_purge_upgrade_members
        WHERE new_job_id IS NULL ORDER BY image_id LIMIT 1000`
    )).rows;
    if (!batch.length) break;
    await client.query(
      `UPDATE imageshow_purge_upgrade_members member SET new_job_id=input.job_id
         FROM jsonb_to_recordset($1::jsonb) AS input(image_id uuid, job_id uuid)
        WHERE member.image_id=input.image_id`,
      [JSON.stringify(batch.map((row) => ({ ...row, job_id: randomUuidV7() })))]
    );
  }
  // No referenced images means physical deletion has already finished. Startup
  // changes the vocabulary cache epoch, so no old count cache can remain valid.
  const retired = await client.query(
    `UPDATE background_job job
        SET status='succeeded', execution_token=NULL, next_retry_at=NULL,
            payload='{}'::jsonb, error='', updated_at=now()
      WHERE type='trash.purge' AND status<>'succeeded'
        AND NOT EXISTS (
          SELECT 1 FROM imageshow_purge_upgrade_members WHERE source_job_id=job.id
        )`
  );
  await client.query(
    `UPDATE background_job job
        SET target_id=member.image_id::text,
            idempotency_key='trash.purge:' || member.image_id::text,
            status=member.status, execution_token=NULL, payload='{}'::jsonb,
            retry_count=member.retry_count, next_retry_at=member.next_retry_at,
            error=member.error, updated_at=member.updated_at
       FROM imageshow_purge_upgrade_members member
      WHERE member.member_order=1 AND job.id=member.source_job_id`
  );
  await client.query(
    `INSERT INTO background_job(
       id, type, target_id, idempotency_key, status, retry_count,
       next_retry_at, error, created_at, updated_at
     )
     SELECT new_job_id, 'trash.purge', image_id::text, 'trash.purge:' || image_id::text,
            status, retry_count, next_retry_at, error, created_at, updated_at
       FROM imageshow_purge_upgrade_members WHERE member_order>1`
  );
  const verification = (await client.query(
    `SELECT count(*)::int AS migrated_images,
            count(*) FILTER (WHERE job.id IS NULL
              OR job.type<>'trash.purge' OR job.target_id<>member.image_id::text
              OR job.idempotency_key IS DISTINCT FROM 'trash.purge:' || member.image_id::text
              OR job.status<>member.status OR job.retry_count<>member.retry_count
              OR job.next_retry_at IS DISTINCT FROM member.next_retry_at
              OR job.error<>member.error OR job.execution_token IS NOT NULL
            )::int AS invalid_count
       FROM imageshow_purge_upgrade_members member
       LEFT JOIN background_job job ON job.id=member.new_job_id`
  )).rows[0];
  if (Number(verification?.invalid_count)) {
    throw new Error("6.4.4 purge task conversion did not preserve every deletion intent");
  }
  await client.query("ALTER TABLE public.metadata DROP COLUMN purge_job_id");
  const preservedCount = (await client.query("SELECT count(*)::text AS count FROM metadata")).rows[0]?.count;
  if (preservedCount !== metadataCount) {
    throw new Error("6.4.4 purge task conversion changed the image count");
  }
  return {
    migrated_images: Number(verification?.migrated_images ?? 0),
    retired_empty_jobs: retired.rowCount ?? 0
  };
}
