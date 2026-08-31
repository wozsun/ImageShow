import type { PoolClient } from "pg";
import { randomUuidV7 } from "../uuid.ts";

const legacyPurgeColumns = [
  "purge_attempts",
  "purge_error",
  "purge_started_at",
  "purge_state"
] as const;

type LegacyTrashPurgeJob = {
  id: string;
  payload: unknown;
};

type LegacyTrashPurgeWatermark = {
  deletedAt: string;
  id: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseLegacyTrashPurgeWatermark(
  payload: unknown
): LegacyTrashPurgeWatermark | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const watermark = (payload as Record<string, unknown>).watermark;
  if (!watermark || typeof watermark !== "object" || Array.isArray(watermark)) {
    return null;
  }
  const { deletedAt, id } = watermark as Record<string, unknown>;
  if (
    typeof deletedAt !== "string"
    || !deletedAt
    || !Number.isFinite(Date.parse(deletedAt))
    || typeof id !== "string"
    || !uuidPattern.test(id)
  ) {
    return null;
  }
  return { deletedAt, id: id.toLowerCase() };
}

async function presentLegacyPurgeColumns(client: PoolClient) {
  return (await client.query<{ column_name: string }>(
    `SELECT attribute.attname AS column_name
       FROM pg_attribute attribute
      WHERE attribute.attrelid=to_regclass('public.metadata')
        AND attribute.attname=ANY($1::text[])
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attname`,
    [legacyPurgeColumns]
  )).rows.map((row) => row.column_name);
}

function assertCompleteLegacyPurgeShape(columns: string[]) {
  if (columns.length === 0) return false;
  if (
    columns.length !== legacyPurgeColumns.length
    || legacyPurgeColumns.some((column) => !columns.includes(column))
  ) {
    throw new Error(
      "5.4.2 cannot safely clean a partial legacy trash-purge schema: "
      + `found ${columns.join(", ") || "no recognized columns"}`
    );
  }
  return true;
}

async function readLegacyTrashPurgeJobs(client: PoolClient) {
  return (await client.query<LegacyTrashPurgeJob>(
    `SELECT id, payload
       FROM background_job
      WHERE type='trash.purge'
        AND status IN ('pending', 'running', 'failed')
      ORDER BY created_at, id
      FOR UPDATE`
  )).rows;
}

async function bindLegacyTrashPurgeIntent(
  client: PoolClient,
  jobs: LegacyTrashPurgeJob[],
  watermarks: LegacyTrashPurgeWatermark[]
) {
  const targets = (await client.query<{ id: string }>(
    `WITH watermarks AS (
       SELECT *
         FROM unnest($1::timestamptz[], $2::uuid[])
           AS watermark(deleted_at, id)
     )
     SELECT metadata.id
       FROM metadata
      WHERE metadata.status='deleted'
        AND metadata.purge_job_id IS NULL
        AND (
          metadata.purge_state<>'idle'
          OR EXISTS (
            SELECT 1
              FROM watermarks
             WHERE (metadata.deleted_at, metadata.id)
                   <= (watermarks.deleted_at, watermarks.id)
          )
        )
      ORDER BY metadata.deleted_at, metadata.id
      FOR UPDATE`,
    [
      watermarks.map((watermark) => watermark.deletedAt),
      watermarks.map((watermark) => watermark.id)
    ]
  )).rows;

  let replacementJobId: string | null = null;
  if (targets.length) {
    replacementJobId = randomUuidV7();
    await client.query(
      `INSERT INTO background_job(id, type, target_id, payload)
       VALUES($1, 'trash.purge', '', $2::jsonb)`,
      [
        replacementJobId,
        JSON.stringify({
          retain_exhausted: true,
          upgraded_from: "5.4.1"
        })
      ]
    );
    const rebound = await client.query(
      `UPDATE metadata
          SET purge_job_id=$1,
              purge_attempts=CASE
                WHEN purge_state<>'idle' THEN purge_attempts + 1
                ELSE purge_attempts
              END,
              updated_at=now()
        WHERE id=ANY($2::uuid[])
          AND status='deleted'
          AND purge_job_id IS NULL
        RETURNING id`,
      [replacementJobId, targets.map((row) => row.id)]
    );
    if (rebound.rowCount !== targets.length) {
      throw new Error("5.4.2 legacy trash-purge binding lost its locked target set");
    }
  }

  if (jobs.length) {
    await client.query(
      `UPDATE background_job
          SET status='succeeded',
              payload=jsonb_set(
                payload,
                '{superseded_by}',
                to_jsonb($2::text),
                true
              ),
              error='',
              next_retry_at=NULL,
              execution_token=NULL,
              updated_at=now()
        WHERE id=ANY($1::uuid[])`,
      [
        jobs.map((job) => job.id),
        replacementJobId ?? "5.4.2-no-remaining-images"
      ]
    );
  }

  return {
    migratedImages: targets.length,
    supersededJobs: jobs.length,
    replacementJobId
  };
}

export type SchemaUpgrade542Result = {
  cleanedLegacyPurgeSchema: boolean;
  migratedImages: number;
  supersededJobs: number;
  replacementJobId: string | null;
};

/**
 * One-cycle 5.4.2 compatibility. The caller owns the bootstrap transaction.
 * 5.4.3 removes this function after every controlled database has crossed the
 * physical legacy-column cleanup boundary.
 */
export async function applySchemaUpgrade542(
  client: PoolClient
): Promise<SchemaUpgrade542Result> {
  const columns = await presentLegacyPurgeColumns(client);
  if (!assertCompleteLegacyPurgeShape(columns)) {
    return {
      cleanedLegacyPurgeSchema: false,
      migratedImages: 0,
      supersededJobs: 0,
      replacementJobId: null
    };
  }

  // ALTER TABLE needs this lock later. Taking it before reading legacy intent
  // makes the compatibility snapshot and physical cleanup one indivisible
  // boundary while the supported single old application process is stopped.
  await client.query("LOCK TABLE metadata IN ACCESS EXCLUSIVE MODE");
  const jobs = await readLegacyTrashPurgeJobs(client);
  const parsed = jobs.map((job) => ({
    job,
    watermark: parseLegacyTrashPurgeWatermark(job.payload)
  }));
  const malformed = parsed.filter((entry) => entry.watermark === null);
  if (malformed.length) {
    throw new Error(
      "5.4.2 cannot safely infer the scope of legacy trash.purge jobs: "
      + malformed.slice(0, 10).map((entry) => entry.job.id).join(", ")
    );
  }
  const migration = await bindLegacyTrashPurgeIntent(
    client,
    jobs,
    parsed.map((entry) => entry.watermark as LegacyTrashPurgeWatermark)
  );

  await client.query("DROP INDEX IF EXISTS idx_metadata_trash_purge");
  await client.query(
    `ALTER TABLE metadata
       DROP COLUMN purge_state,
       DROP COLUMN purge_started_at,
       DROP COLUMN purge_attempts,
       DROP COLUMN purge_error`
  );

  return {
    cleanedLegacyPurgeSchema: true,
    ...migration
  };
}
