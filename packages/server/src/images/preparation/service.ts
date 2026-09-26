import { randomUUID } from "node:crypto";
import { open, rm, statfs, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultPreparationProfile, imageVariants, parsePreparationProfile,
  type PreparationControl, type PreparationItemDto, type PreparationState, type PreparationStatusDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { pool } from "../../core/database/pools.ts";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import { getIngestionMaxFileBytes } from "../../config/app-settings.ts";
import { makeDurableDirectory, syncDirectory } from "../../storage/drivers/local-publication.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { profileFingerprint } from "../variants/encoding.ts";
import { processIdentity, previousProcessExited } from "./process-ownership.ts";
import {
  createPreparationRun, currentSource, durableTransaction, latestPreparationRun, saveRecord, saveRun
} from "./repository.ts";
import { sameSource, type PreparationRecord, type PreparationRun } from "./model.ts";

async function assertPreparationDurability() {
  await processIdentity();
  const settings = (await pool.query(
    "SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes"
  )).rows[0];
  if (settings.fsync !== "on" || settings.full_page_writes !== "on") throw new Error("预生成要求 PostgreSQL fsync 和 full_page_writes 均开启");
  for (const directory of [runtimePaths.storageDirectory, join(runtimePaths.configDirectory, "normalize-preparation")]) {
    await makeDurableDirectory(directory);
    const path = join(directory, `.prepare-capability-${randomUUID()}`);
    const handle = await open(path, "wx");
    try { await handle.writeFile("prepare"); await handle.sync(); } finally { await handle.close(); }
    try { await syncDirectory(directory); } finally { await unlink(path); await syncDirectory(directory); }
  }
}

export async function assertPreparationSpace(concurrency: number, largestOutputs: number) {
  const locations = await Promise.all([runtimePaths.storageDirectory, runtimePaths.configDirectory].map(async (path) => ({
    path, info: await statfs(path, { bigint: true })
  })));
  const perSlot = 2 * getIngestionMaxFileBytes() + 2 * largestOutputs + 256 * 1024 * 1024;
  const required = BigInt(Math.ceil(Math.max(1024 ** 3, concurrency * perSlot)));
  for (const { info } of locations) {
    if (info.bavail * info.bsize < required) throw new Error(`磁盘安全余量不足，需要至少 ${Math.ceil(Number(required) / 1024 ** 2)} MiB 可用空间`);
  }
}

export async function controlPreparation(input: PreparationControl) {
  const actions = ["start", "stop", "verify", "retry", "reconcile", "set-concurrency"];
  if (!input || !actions.includes(input.action) || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new ApiError(400, "validation_error", "预生成控制参数无效");
  }
  const profile = input.profile === undefined ? undefined : parsePreparationProfile(input.profile);
  if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 8)) {
    throw new ApiError(400, "validation_error", "并发数必须是 1–8 的整数");
  }
  if (["start", "verify"].includes(input.action)) await assertPreparationDurability();
  await durableTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('imageshow:preparation-control',0))");
    let run = await latestPreparationRun(client, true);
    if ((run?.payload.revision ?? 0) !== input.revision) throw new ApiError(409, "preparation_revision_conflict", "任务状态已变化，请刷新后重试");
    if (!run) {
      if (input.action !== "start") throw new ApiError(409, "preparation_not_started", "请先设置参数并开始预生成");
      await createPreparationRun(client, profile ?? defaultPreparationProfile(), input.concurrency ?? 1, 1);
      return;
    }
    const active = run.status === "running";
    if (input.action === "start" && profile && profileFingerprint(profile) !== run.payload.fingerprint) {
      if (active || run.payload.desired_state !== "stopped") throw new ApiError(409, "preparation_drain_required", "修改参数前请停止并等待所有图片处理退出");
      await assertPreviousChildrenExited(run.id);
      await createPreparationRun(client, profile, input.concurrency ?? run.payload.concurrency, run.payload.revision + 1);
      return;
    }
    run.payload.revision += 1;
    switch (input.action) {
      case "stop": run.payload.desired_state = "stopped"; run.payload.reconcile_requested = false; break;
      case "start":
      case "verify": {
        const mode = input.action === "start" ? "generate" : "verify";
        if (active && mode === "verify") throw new ApiError(409, "preparation_drain_required", "核验启动前必须等待当前任务停止");
        if (active && (run.payload.execution_mode !== mode || run.payload.desired_state === "stopped")) {
          throw new ApiError(409, "preparation_drain_required", "请等待停止完成后再启动或切换模式");
        }
        if (!active) await assertPreviousChildrenExited(run.id);
        run.payload.execution_mode = mode;
        run.payload.desired_state = "running";
        run.payload.block = null;
        if (!active) { run.payload.cursor = null; run.payload.enumerated = false; }
        if (mode === "verify") { run.payload.verification += 1; run.payload.verified_at = null; }
        if (!active) run.status = "pending";
        break;
      }
      case "set-concurrency":
        if (input.concurrency === undefined) throw new ApiError(400, "validation_error", "缺少并发数");
        run.payload.concurrency = input.concurrency;
        break;
      case "retry": {
        const rows = (await client.query<PreparationRecord>(
          "SELECT * FROM image_variant_preparation WHERE run_id=$1 AND state IN ('failed','stale')", [run.id]
        )).rows;
        for (const row of rows) {
          const source = await currentSource(row.image_id, client);
          if (!source) { row.state = "excluded"; await saveRecord(client, row); continue; }
          if (!sameSource(source, row.data.source)) {
            if (row.data.input) {
              // Remove durably before dropping ownership. A rolled-back receipt can safely
              // point to a missing input: generation checks existence before reuse.
              await rm(row.data.input.path, { force: true });
              await syncDirectory(dirname(row.data.input.path));
            }
            delete row.data.input;
            row.data.source = source;
          }
          row.state = "pending";
          Object.assign(row.data, { attempt: randomUuidV7(), counted: false, retries: 0, error: "", next_retry_at: null });
          await saveRecord(client, row);
        }
        run.payload.verified_at = null;
        break;
      }
      case "reconcile":
        run.payload.cursor = null;
        run.payload.enumerated = false;
        run.payload.reconcile_requested = true;
        if (active) run.payload.rerun_requested = true;
        // Discovery is permitted while stopped, but never changes generation intent.
        if (!active) run.status = "pending";
        break;
    }
    if (input.action === "start" && input.concurrency !== undefined) run.payload.concurrency = input.concurrency;
    await saveRun(client, run);
  });
  return readPreparationStatus();
}

export async function assertPreviousChildrenExited(runId: string) {
  const rows = (await pool.query<PreparationRecord>(
    "SELECT * FROM image_variant_preparation WHERE run_id=$1 AND data->'child'<>'null'::jsonb", [runId]
  )).rows;
  for (const row of rows) {
    if (row.data.child && !await previousProcessExited(row.data.child)) throw new Error("旧图片进程尚未退出，任务保持恢复等待");
  }
}

function itemDto(row: PreparationRecord & { title?: string }): PreparationItemDto {
  return {
    image_id: row.image_id, title: row.title ?? "", state: row.state, phase: row.data.phase,
    error: row.data.error, retries: row.data.retries, updated_at: new Date(row.updated_at).toISOString(),
    variants: Object.fromEntries(imageVariants.flatMap((variant) => row.data.variants[variant]?.facts
      ? [[variant, row.data.variants[variant]!.facts]] : []))
  };
}

export async function readPreparationStatus(page = 1): Promise<PreparationStatusDto> {
  const run = await latestPreparationRun();
  const counts: Record<PreparationState, number> = { pending: 0, running: 0, ready: 0, failed: 0, stale: 0, excluded: 0 };
  const total = Number((await pool.query("SELECT count(*) AS n FROM metadata")).rows[0].n);
  const base: PreparationStatusDto = {
    run_id: run?.id ?? null, profile: run?.payload.profile ?? defaultPreparationProfile(), revision: run?.payload.revision ?? 0,
    mode: run?.payload.execution_mode ?? "generate", desired_state: run?.payload.desired_state ?? "stopped",
    state: "未开始", concurrency: run?.payload.concurrency ?? 1, block: run?.payload.block ?? null,
    completed_attempts: run?.payload.completed_attempts ?? 0, rest: run?.payload.rest ?? null,
    server_time: new Date().toISOString(), total, untracked: total, deletion_pending: 0,
    variant_counts: { large: 0, middle: 0, small: 0 }, counts, active: [], items: [], page, pages: 1,
    verified_at: run?.payload.verified_at ?? null
  };
  if (!run) return base;
  const result = (await pool.query<{ state: PreparationState; n: number }>(
    `SELECT CASE WHEN m.id IS NULL THEN 'excluded'
       WHEN p.state='ready' AND (p.data->'source'->>'original' IS DISTINCT FROM m.original
         OR p.data->'source'->>'storage_slug' IS DISTINCT FROM m.storage_slug) THEN 'stale'
       ELSE p.state END AS state,count(*)::int AS n
     FROM image_variant_preparation p LEFT JOIN metadata m ON m.id=p.image_id WHERE run_id=$1 GROUP BY 1`, [run.id]
  )).rows;
  for (const row of result) counts[row.state] = row.n;
  const summary = (await pool.query(
    `SELECT count(*) FILTER (WHERE p.image_id IS NULL)::int AS untracked,
       count(*) FILTER (WHERE EXISTS(SELECT 1 FROM background_job j WHERE j.type='trash.purge' AND j.target_id=m.id::text))::int AS deletion_pending,
       count(*) FILTER (WHERE p.data->'variants'->'large'->'facts' IS NOT NULL)::int AS large,
       count(*) FILTER (WHERE p.data->'variants'->'middle'->'facts' IS NOT NULL)::int AS middle,
       count(*) FILTER (WHERE p.data->'variants'->'small'->'facts' IS NOT NULL)::int AS small
     FROM metadata m LEFT JOIN image_variant_preparation p ON p.image_id=m.id AND p.run_id=$1`, [run.id]
  )).rows[0];
  base.untracked = summary.untracked;
  base.deletion_pending = summary.deletion_pending;
  base.variant_counts = { large: summary.large, middle: summary.middle, small: summary.small };
  const known = Object.values(counts).reduce((a, b) => a + b, 0);
  base.pages = Math.max(1, Math.ceil(known / 30));
  const query = "SELECT p.*,m.title FROM image_variant_preparation p LEFT JOIN metadata m ON m.id=p.image_id WHERE run_id=$1";
  const [items, active] = await Promise.all([
    pool.query<PreparationRecord & { title: string }>(`${query} ORDER BY image_id LIMIT 30 OFFSET $2`, [run.id, (page - 1) * 30]),
    pool.query<PreparationRecord & { title: string }>(`${query} AND p.state='running' ORDER BY p.updated_at LIMIT 8`, [run.id])
  ]);
  base.items = items.rows.map(itemDto);
  base.active = active.rows.map(itemDto);
  base.state = run.payload.block ? "受阻" : run.status === "running"
    ? run.payload.desired_state === "stopped" ? "正在停止" : run.payload.rest ? "随机休息" : run.payload.execution_mode === "verify" ? "核验中" : "生成中"
    : run.status === "pending" ? "等待调度" : run.payload.desired_state === "stopped" ? "已停止" : "本轮完成";
  if (run.status === "running" && run.payload.owner && await previousProcessExited(run.payload.owner)) {
    base.state = "恢复等待";
  }
  return base;
}

export function preparationRunIsExecutable(run: PreparationRun) {
  return run.payload.desired_state === "running" && !run.payload.block;
}
