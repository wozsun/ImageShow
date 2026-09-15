import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runIntegrationScenario } from "./integration-runtime.mts";

// Temporary upgrade coverage, removed together with the converter in 6.4.5.
await runIntegrationScenario(async ({ databasePools }) => {
  const { pool } = databasePools;
  const { initializeDatabaseSchema } = await import("../../../../packages/server/src/core/database/schema.ts");
  const { upgradeTrashPurgeFor644 } = await import("../../../../packages/server/src/core/database/upgrade-6.4.4.ts");
  const { appConfig } = await import("@imageshow/shared");
  const businessSnapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ["metadata", "author", "tag", "theme", "image_tag", "storage_backend", "admin_account"]) {
      result[table] = (await pool.query(`SELECT to_jsonb(row) - 'purge_job_id' AS data FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows;
    }
    return result;
  };
  const jobsSnapshot = async () => (await pool.query("SELECT * FROM background_job ORDER BY id")).rows;
  const schemaSnapshot = async () => (await pool.query(
    "SELECT attname, atttypid, attnotnull FROM pg_attribute WHERE attrelid='metadata'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum"
  )).rows;
  const addLegacyColumn = () => pool.query("ALTER TABLE metadata ADD COLUMN purge_job_id uuid CHECK (purge_job_id IS NULL OR status='deleted')");
  const addImage = async (jobId: string | null, status = "deleted") => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO metadata(id,created_by,status,storage_slug,object_key,device,brightness,ext,md5,deleted_at,purge_job_id) VALUES($1,'integration-admin',$2,'local',$3,'pc','dark','webp',$4,now(),$5)",
      [id, status, `full/${id}.webp`, "0".repeat(32), jobId]
    );
    return id;
  };
  await addLegacyColumn();
  await pool.query("INSERT INTO tag(slug,display_name) VALUES('upgrade-tag','Upgrade tag')");
  const ready = await addImage(null, "ready");
  await addImage(null);
  await pool.query("INSERT INTO image_tag(image_id,tag_slug) VALUES($1,'upgrade-tag')", [ready]);
  const expected: { imageId: string; jobId: string; status: string; retries: number; error: string; retry: Date | null }[] = [];
  for (const [status, retries, size, hasRetry] of [
    ["pending", 0, 2, false], ["failed", 2, 2, true],
    ["failed", appConfig.backgroundJob.maxRetries, 1, false],
    ["running", 1, 2, false], ["running", appConfig.backgroundJob.maxRetries - 1, 1, false]
  ] as const) {
    const jobId = randomUUID();
    const retry = hasRetry ? new Date(Date.now() + 600_000) : null;
    await pool.query(
      "INSERT INTO background_job(id,type,status,retry_count,next_retry_at,error,execution_token,payload) VALUES($1,'trash.purge',$2,$3,$4,'original error',$5,'{\"retain_exhausted\":true}')",
      [jobId, status, retries, retry, status === "running" ? randomUUID() : null]
    );
    for (let i = 0; i < size; i += 1) expected.push({
      imageId: await addImage(jobId), jobId,
      status: status === "running" ? "failed" : status,
      retries: retries + (status === "running" ? 1 : 0),
      error: status === "running" ? "Recovered running task during 6.4.4 upgrade" : "original error",
      retry
    });
  }
  const emptyJob = randomUUID();
  const completedJob = randomUUID();
  const otherJob = randomUUID();
  await pool.query(
    "INSERT INTO background_job(id,type,status,payload) VALUES($1,'trash.purge','pending','{}'),($2,'trash.purge','succeeded','{}'),($3,'move.cleanup','failed','{\"retain_exhausted\":true}')",
    [emptyJob, completedJob, otherJob]
  );
  const businessBefore = await businessSnapshot();
  const otherBefore = (await pool.query("SELECT * FROM background_job WHERE id=ANY($1::uuid[]) ORDER BY id", [[completedJob, otherJob]])).rows;
  await Promise.all([initializeDatabaseSchema(), initializeDatabaseSchema()]);
  assert.deepEqual(await businessSnapshot(), businessBefore, "升级保留图片、词表、关联、存储和管理员数据");
  assert.equal((await schemaSnapshot()).some((row) => row.attname === "purge_job_id"), false);
  for (const item of expected) {
    const rows = (await pool.query("SELECT * FROM background_job WHERE type='trash.purge' AND target_id=$1", [item.imageId])).rows;
    assert.equal(rows.length, 1);
    const job = rows[0]!;
    assert.equal(job.idempotency_key, `trash.purge:${item.imageId}`);
    assert.equal(job.status, item.status);
    assert.equal(job.retry_count, item.retries);
    assert.equal(job.error, item.error);
    assert.equal(job.execution_token, null);
    assert.deepEqual(job.payload, {});
    if (item.error === "original error") assert.deepEqual(job.next_retry_at, item.retry);
    else if (item.retries >= appConfig.backgroundJob.maxRetries) assert.equal(job.next_retry_at, null);
    else assert.ok(job.next_retry_at instanceof Date && job.next_retry_at.getTime() <= Date.now());
  }
  for (const jobId of new Set(expected.map((item) => item.jobId))) {
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM background_job WHERE id=$1", [jobId])).rows[0]?.count, 1);
  }
  assert.equal((await pool.query("SELECT status FROM background_job WHERE id=$1", [emptyJob])).rows[0]?.status, "succeeded");
  assert.deepEqual((await pool.query("SELECT * FROM background_job WHERE id=ANY($1::uuid[]) ORDER BY id", [[completedJob, otherJob]])).rows, otherBefore);
  const convertedJobs = await jobsSnapshot();
  await initializeDatabaseSchema();
  assert.deepEqual(await jobsSnapshot(), convertedJobs, "重复启动不重建或重置任务");

  for (const failure of ["missing", "wrong-type", "succeeded", "key-conflict", "readiness"] as const) {
    await addLegacyColumn();
    const jobId = randomUUID();
    const conflictingId = randomUUID();
    if (failure !== "missing") await pool.query(
      "INSERT INTO background_job(id,type,status) VALUES($1,$2,$3)",
      [jobId, failure === "wrong-type" ? "move.cleanup" : "trash.purge", failure === "succeeded" ? "succeeded" : "pending"]
    );
    const imageId = await addImage(jobId);
    if (failure === "key-conflict") await pool.query(
      "INSERT INTO background_job(id,type,target_id,idempotency_key) VALUES($1,'trash.purge',$2,$3)",
      [conflictingId, imageId, `trash.purge:${imageId}`]
    );
    if (failure === "readiness") await pool.query("ALTER TABLE tag RENAME COLUMN display_name TO upgrade_display_name");
    const before = [await schemaSnapshot(), await businessSnapshot(), await jobsSnapshot()];
    await assert.rejects(initializeDatabaseSchema(), failure === "key-conflict" ? /duplicate key/ : failure === "readiness" ? /required columns/ : /invalid purge references/);
    assert.deepEqual([await schemaSnapshot(), await businessSnapshot(), await jobsSnapshot()], before, `${failure} 失败整体回滚`);
    if (failure === "readiness") await pool.query("ALTER TABLE tag RENAME COLUMN upgrade_display_name TO display_name");
    await pool.query("DELETE FROM metadata WHERE id=$1", [imageId]);
    await pool.query("DELETE FROM background_job WHERE id=ANY($1::uuid[])", [[jobId, conflictingId]]);
    await pool.query("ALTER TABLE metadata DROP COLUMN purge_job_id");
  }

  await pool.query("ALTER TABLE metadata ADD COLUMN purge_job_id text");
  await assert.rejects(initializeDatabaseSchema(), /requires a UUID/);
  await pool.query("ALTER TABLE metadata DROP COLUMN purge_job_id");
  await addLegacyColumn();
  const beforePermissions = [await schemaSnapshot(), await jobsSnapshot()];
  await pool.query("CREATE ROLE upgrade644_reader NOLOGIN");
  await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO upgrade644_reader");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE upgrade644_reader");
    await assert.rejects(upgradeTrashPurgeFor644(client), /permission denied/);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  assert.deepEqual([await schemaSnapshot(), await jobsSnapshot()], beforePermissions);
  await pool.query("DROP OWNED BY upgrade644_reader");
  await pool.query("DROP ROLE upgrade644_reader");
  await pool.query("ALTER TABLE metadata DROP COLUMN purge_job_id");
});
