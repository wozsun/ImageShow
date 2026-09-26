import { randomInt } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { PoolClient } from "pg";
import { imageVariants, type PreparationProfile } from "@imageshow/shared/browser";
import { pool } from "../../core/database/pools.ts";
import { withTransaction } from "../../core/database/transactions.ts";
import { ApiError } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { profileFingerprint } from "../variants/encoding.ts";
import { sameSource, type PreparationRecord, type PreparationRun, type SourceSnapshot } from "./model.ts";
import { preparationTarget } from "./paths.ts";

export async function durableTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  return withTransaction(async (client) => {
    // Preserve remote_apply/remote_write; never weaken an administrator's stronger setting.
    const setting = (await client.query("SHOW synchronous_commit")).rows[0]?.synchronous_commit;
    if (setting === "off") await client.query("SET LOCAL synchronous_commit = 'on'");
    return work(client);
  });
}

export async function latestPreparationRun(client: Pick<PoolClient, "query"> = pool, lock = false) {
  return (await client.query<PreparationRun>(
    `SELECT id,status,execution_token,payload FROM background_job
     WHERE type='normalize.prepare' ORDER BY created_at DESC,id DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`
  )).rows[0];
}

export async function lockedRun(client: PoolClient, id: string) {
  const row = (await client.query<PreparationRun>(
    "SELECT id,status,execution_token,payload FROM background_job WHERE id=$1 AND type='normalize.prepare' FOR UPDATE", [id]
  )).rows[0];
  if (!row) throw new ApiError(404, "preparation_missing", "预生成任务不存在");
  return row;
}

export async function saveRun(client: PoolClient, run: PreparationRun) {
  await client.query(
    "UPDATE background_job SET payload=$2::jsonb,status=$3,execution_token=$4,updated_at=clock_timestamp() WHERE id=$1",
    [run.id, JSON.stringify(run.payload), run.status, run.execution_token]
  );
}

export async function createPreparationRun(client: PoolClient, profile: PreparationProfile, concurrency: number, revision: number) {
  const run: PreparationRun = {
    id: randomUuidV7(), status: "pending", execution_token: null,
    payload: {
      profile, fingerprint: profileFingerprint(profile), revision, desired_state: "running",
      execution_mode: "generate", concurrency, block: null, cursor: null, enumerated: false, reconcile_requested: false,
      completed_attempts: 0, next_short: 18, next_long: 100, rest: null,
      verified_at: null, verification: 0, owner: null, max_output_bytes: 0
    }
  };
  await client.query(
    "INSERT INTO background_job(id,type,target_id,payload) VALUES($1::uuid,'normalize.prepare',($1::uuid)::text,$2::jsonb)",
    [run.id, JSON.stringify(run.payload)]
  );
  return run;
}

export async function currentSource(imageId: string, client: Pick<PoolClient, "query"> = pool, lock = false): Promise<SourceSnapshot | undefined> {
  return (await client.query<SourceSnapshot>(
    `SELECT m.original,m.storage_slug,b.type AS storage_type FROM metadata m
     JOIN storage_backend b ON b.slug=m.storage_slug WHERE m.id=$1 ${lock ? "FOR SHARE OF m,b" : ""}`, [imageId]
  )).rows[0];
}

function initialRecord(run: string, image: string, source: SourceSnapshot): Omit<PreparationRecord, "updated_at"> {
  return {
    run_id: run, image_id: image, state: "pending",
    data: { source, phase: "等待处理", token: null, child: null, attempt: randomUuidV7(), counted: false,
      retries: 0, error: "", next_retry_at: null, verified: 0, variants: {} }
  };
}

export async function saveRecord(client: Pick<PoolClient, "query">, row: Omit<PreparationRecord, "updated_at">) {
  await client.query(
    `INSERT INTO image_variant_preparation(run_id,image_id,state,data) VALUES($1,$2,$3,$4::jsonb)
     ON CONFLICT(run_id,image_id) DO UPDATE SET state=EXCLUDED.state,data=EXCLUDED.data,updated_at=clock_timestamp()`,
    [row.run_id, row.image_id, row.state, JSON.stringify(row.data)]
  );
}

export async function readRecord(run: string, image: string, client: Pick<PoolClient, "query"> = pool) {
  return (await client.query<PreparationRecord>(
    "SELECT * FROM image_variant_preparation WHERE run_id=$1 AND image_id=$2", [run, image]
  )).rows[0];
}

export async function updateOwnedRecord(runId: string, image: string, token: string, change: (row: PreparationRecord, run: PreparationRun) => void | Promise<void>) {
  return durableTransaction(async (client) => {
    const run = await lockedRun(client, runId);
    const row = await readRecord(runId, image, client);
    if (!row || row.data.token !== token || row.state !== "running") throw new Error("预生成图片执行权已失效");
    await change(row, run);
    await saveRecord(client, row);
    return row;
  });
}

/** Cursor enumeration is bounded; reconciliation explicitly starts a new pass. */
export async function enumeratePreparation(runId: string) {
  return durableTransaction(async (client) => {
    const run = await lockedRun(client, runId);
    if (run.payload.enumerated) return;
    const rows = (await client.query<SourceSnapshot & { id: string }>(
      `SELECT m.id,m.original,m.storage_slug,b.type AS storage_type FROM metadata m
       JOIN storage_backend b ON b.slug=m.storage_slug WHERE ($1::uuid IS NULL OR m.id>$1)
       ORDER BY m.id LIMIT 200`, [run.payload.cursor]
    )).rows;
    for (const source of rows) {
      const prior = await readRecord(runId, source.id, client);
      if (!prior) await saveRecord(client, initialRecord(runId, source.id, {
        original: source.original, storage_slug: source.storage_slug, storage_type: source.storage_type
      }));
      else if (!sameSource(prior.data.source, source) && prior.state !== "running") {
        prior.state = "stale";
        prior.data.error = "原图地址或存储位置已变更；停止后使用新任务重新确认";
        await saveRecord(client, prior);
        run.payload.verified_at = null;
      } else if (prior.state === "ready") {
        for (const variant of imageVariants) {
          const facts = prior.data.variants[variant]?.facts;
          const info = await lstat(preparationTarget(prior.image_id, variant)).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          });
          if (!facts || !info?.isFile() || info.isSymbolicLink() || info.size !== facts.bytes) {
            prior.state = "stale";
            prior.data.error = `${variant} 文件缺失或体积改变，请明确重试并生成`;
            run.payload.verified_at = null;
            await saveRecord(client, prior);
            break;
          }
        }
      }
    }
    run.payload.cursor = rows.at(-1)?.id ?? run.payload.cursor;
    run.payload.enumerated = rows.length < 200;
    await client.query(
      `UPDATE image_variant_preparation p SET state='excluded',data=jsonb_set(data,'{phase}','"图片已删除"'::jsonb)
       WHERE run_id=$1 AND state<>'running' AND NOT EXISTS(SELECT 1 FROM metadata m WHERE m.id=p.image_id)`, [runId]
    );
    await saveRun(client, run);
  });
}

export async function claimPreparationRecord(runId: string, jobToken: string) {
  return durableTransaction(async (client) => {
    const run = await lockedRun(client, runId);
    if (run.execution_token !== jobToken || run.payload.desired_state !== "running" || run.payload.block) return;
    const active = Number((await client.query(
      "SELECT count(*) AS n FROM image_variant_preparation WHERE run_id=$1 AND state='running'", [runId]
    )).rows[0].n);
    if (active >= run.payload.concurrency) return;
    if (run.payload.rest) {
      if (!run.payload.rest.deadline) return;
      const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      if (now.getTime() < Date.parse(run.payload.rest.deadline)) return;
      run.payload.rest = null;
      await saveRun(client, run);
    }
    const row = (await client.query<PreparationRecord>(
      `SELECT * FROM image_variant_preparation WHERE run_id=$1 AND (
        ($2='generate' AND state='pending' AND (data->>'next_retry_at' IS NULL OR (data->>'next_retry_at')::timestamptz<=clock_timestamp()))
        OR ($2='verify' AND state='ready' AND (data->>'verified')::int<$3)
       ) ORDER BY image_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [runId, run.payload.execution_mode, run.payload.verification]
    )).rows[0];
    if (!row) return;
    row.state = "running";
    row.data.token = randomUuidV7();
    row.data.phase = run.payload.execution_mode === "verify" ? "核验文件" : "准备原图";
    await saveRecord(client, row);
    return row;
  });
}

export async function finishPreparationRecord(
  row: PreparationRecord, mode: "generate" | "verify", outcome: "ready" | "failed" | "interrupted" | "excluded", message = ""
) {
  return durableTransaction(async (client) => {
    const run = await lockedRun(client, row.run_id);
    const current = await readRecord(row.run_id, row.image_id, client);
    if (!current || current.data.token !== row.data.token) return;
    if (outcome === "ready") {
      const source = await currentSource(row.image_id, client, true);
      if (!source) outcome = "excluded";
      else if (!sameSource(current.data.source, source)) { outcome = "failed"; message = "完成时原图或后端已变更，请显式重试"; }
    }
    current.data.child = null;
    current.data.token = null;
    current.data.error = message;
    current.data.phase = outcome === "interrupted" ? "等待继续" : outcome === "ready" ? "三档就绪" : message;
    if (outcome === "interrupted") current.state = mode === "verify" ? "ready" : "pending";
    else if (outcome === "failed") {
      current.data.retries += 1;
      current.state = mode === "verify" ? "stale" : current.data.retries >= 3 ? "failed" : "pending";
      current.data.next_retry_at = new Date(Date.now() + current.data.retries * 10_000).toISOString();
    } else current.state = outcome;
    if (outcome === "ready") current.data.verified = run.payload.verification;
    if (outcome === "ready") {
      run.payload.max_output_bytes = Math.max(run.payload.max_output_bytes,
        imageVariants.reduce((sum, variant) => sum + (current.data.variants[variant]?.facts?.bytes ?? 0), 0));
    }
    if (mode === "generate" && !current.data.counted && ["ready", "failed"].includes(current.state)) {
      current.data.counted = true;
      run.payload.completed_attempts += 1;
      const long = run.payload.completed_attempts >= run.payload.next_long;
      const short = run.payload.completed_attempts >= run.payload.next_short;
      if (short) run.payload.next_short += 18;
      if (long) run.payload.next_long += 100;
      if (long && run.payload.rest?.kind !== "long") run.payload.rest = { kind: "long", seconds: randomInt(50, 181), deadline: null };
      else if (short && !run.payload.rest) run.payload.rest = { kind: "short", seconds: randomInt(5, 31), deadline: null };
    }
    await saveRecord(client, current);
    await saveRun(client, run);
  });
}
