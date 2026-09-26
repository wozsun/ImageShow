import { dirname, join } from "node:path";
import { lstat, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { imageVariants, type PreparedVariantFacts } from "@imageshow/shared/browser";
import { getIngestionMaxFileBytes, getIngestionMaxLongEdge } from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { pool } from "../../core/database/pools.ts";
import { runWithAdvisoryLockAcquisitionSignal, tryWithAdvisoryLocks, withAdvisoryLock } from "../../core/database/advisory-locks.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { jobSucceeded } from "../../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../../jobs/types.ts";
import { withImageStorageMutationLock, withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
import { digestLocalFile, makeDurableDirectory, publishLocalCandidate, syncDirectory } from "../../storage/drivers/local-publication.ts";
import { variantFingerprint } from "../variants/encoding.ts";
import { startPreparationChild } from "./child-client.ts";
import { preparationCandidate, preparationTarget, preparationWorkDirectory } from "./paths.ts";
import { processIdentity, previousProcessExited } from "./process-ownership.ts";
import { cleanDeletedPreparationImage } from "./cleanup.ts";
import { assertPreparationSpace, assertPreviousChildrenExited, preparationRunIsExecutable } from "./service.ts";
import { sameSource, type PreparationRecord, type PreparationRun, type PreparedReceipt } from "./model.ts";
import {
  claimPreparationRecord, currentSource, durableTransaction, enumeratePreparation, finishPreparationRecord,
  lockedRun, readRecord, saveRecord, saveRun, updateOwnedRecord
} from "./repository.ts";

const coordinatorLock = "imageshow:normalize-prepare";

function matchingFacts(actual: Partial<PreparedVariantFacts>, expected: PreparedVariantFacts) {
  return actual.bytes === expected.bytes && actual.md5 === expected.md5 && actual.sha256 === expected.sha256
    && actual.width === expected.width && actual.height === expected.height;
}

async function exists(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("产物路径不是普通文件");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function historicalReceipts(image: string) {
  return (await pool.query<PreparationRecord>(
    "SELECT * FROM image_variant_preparation WHERE image_id=$1 ORDER BY updated_at DESC", [image]
  )).rows;
}

async function processPicture(job: BackgroundJob, initial: PreparationRecord, run: PreparationRun, signal: AbortSignal) {
  let row = initial;
  const token = row.data.token!;
  const mode = run.payload.execution_mode;
  let child: Awaited<ReturnType<typeof startPreparationChild>> | undefined;
  let outcome: "ready" | "failed" | "interrupted" | "excluded" = "ready";
  let message = "";
  let fatal: unknown;
  try {
    child = await startPreparationChild(signal);
    const identity = child.identity;
    await updateOwnedRecord(run.id, row.image_id, token, (record) => { record.data.child = identity; });
    const source = await currentSource(row.image_id);
    if (!source) { await cleanDeletedPreparationImage(await historicalReceipts(row.image_id), signal); outcome = "excluded"; return; }
    if (!sameSource(source, row.data.source)) throw new Error("原图地址或存储位置已经变化，请停止后重新建立任务");
    if (source.storage_type !== "local") throw new Error("预生成仅支持本地存储，检测到图片后端变化");
    if (!source.original) throw new Error("图片没有原图 URL");
    const history = await historicalReceipts(row.image_id);
    if (mode === "generate") {
      const directory = preparationWorkDirectory(run.id, row.image_id, row.data.attempt);
      let reusable = row.data.input ?? history.find((old) => sameSource(old.data.source, source) && old.data.input)?.data.input;
      if (reusable && !await exists(reusable.path)) reusable = undefined;
      const inputPath = reusable?.path ?? join(directory, "original");
      const cachePath = join(directory, `cache-${token}`);
      // Register raw ownership before download. A checksum is added only after fsync.
      await updateOwnedRecord(run.id, row.image_id, token, (record) => {
        record.data.input = { path: inputPath, sha256: reusable?.sha256 ?? "", bytes: reusable?.bytes ?? 0 };
        record.data.phase = "下载并校验原图";
        record.data.cache_path = cachePath;
      });
      const opened = await child.request({ action: "open", input: inputPath, url: source.original,
        expectedSha256: reusable?.sha256 || undefined, profile: run.payload.profile,
        maxBytes: getIngestionMaxFileBytes(), maxLongEdge: getIngestionMaxLongEdge(),
        timeoutMs: getRuntimeConfig().import.fetch_timeout_seconds * 1000, cache: cachePath
      });
      row = await updateOwnedRecord(run.id, row.image_id, token, (record) => {
        record.data.input = { path: inputPath, ...opened.input! };
      });
    }
    for (const variant of imageVariants) {
      signal.throwIfAborted();
      const target = preparationTarget(row.image_id, variant);
      const fingerprint = variantFingerprint(run.payload.profile, variant);
      let receipt = row.data.variants[variant];
      if (mode === "verify") {
        if (!receipt?.facts) throw new Error(`${variant} 缺少持久核验记录`);
        const verified = await child.request({ action: "verify", path: target });
        if (!matchingFacts(verified.facts!, receipt.facts)) throw new Error(`${variant} 文件与完成回执不符`);
        continue;
      }
      const inputHash = row.data.input!.sha256;
      let replacement: PreparedReceipt["replaced"];
      if (await exists(target)) {
        const actual = (await child.request({ action: "verify", path: target })).facts!;
        const owner = history.flatMap((old) => {
          const value = old.data.variants[variant];
          return value && (value.facts || value.expected) ? [{ record: old, receipt: value }] : [];
        }).find((entry) => matchingFacts(actual, (entry.receipt.facts ?? entry.receipt.expected)!));
        const replacementOwner = history.map((old) => old.data.variants[variant]?.replaced)
          .find((old) => old && matchingFacts(actual, old.facts));
        if (!owner && !replacementOwner) throw new Error(`${variant} 目标文件已有未知内容，未覆盖`);
        if (owner && owner.receipt.fingerprint === fingerprint && owner.receipt.input_sha256 === inputHash) {
          // Preserve the original ownership proof when adopting another frozen profile's output.
          receipt = { ...owner.receipt, facts: (owner.receipt.facts ?? owner.receipt.expected)! };
          await syncDirectory(dirname(target));
          if (await exists(receipt.candidate)) {
            const candidateFacts = await digestLocalFile(receipt.candidate, signal);
            if (candidateFacts.sha256 !== actual.sha256) throw new Error("已登记候选文件内容发生变化");
            await rm(receipt.candidate);
            await syncDirectory(dirname(target));
          }
          row = await updateOwnedRecord(run.id, row.image_id, token, (record) => { record.data.variants[variant] = receipt; });
          continue;
        }
        replacement = owner ? {
          run_id: owner.record.run_id, sha256: actual.sha256!, facts: (owner.receipt.facts ?? owner.receipt.expected)!
        } : replacementOwner;
      }
      if (receipt?.candidate && await exists(receipt.candidate)) {
        // Only this previously registered candidate is discarded; published targets remain intact.
        await rm(receipt.candidate);
        await syncDirectory(dirname(receipt.candidate));
      }
      const candidate = preparationCandidate(row.image_id, variant, randomUuidV7());
      receipt = {
        fingerprint, candidate, owner_run: run.id, owner_attempt: row.data.attempt,
        input_sha256: inputHash, replaced: replacement
      };
      await makeDurableDirectory(dirname(target));
      row = await updateOwnedRecord(run.id, row.image_id, token, (record) => {
        record.data.phase = `编码 ${variant}`;
        record.data.variants[variant] = receipt;
      });
      const encoded = (await child.request({ action: "encode", variant, candidate })).facts as PreparedVariantFacts;
      row = await updateOwnedRecord(run.id, row.image_id, token, (record) => {
        record.data.variants[variant]!.expected = encoded;
        record.data.phase = `发布 ${variant}`;
      });
      await runWithAdvisoryLockAcquisitionSignal(signal, () => withImageStorageMutationLock(row.image_id, async (lockSignal) => {
        const publicationSignal = AbortSignal.any([signal, lockSignal]);
        publicationSignal.throwIfAborted();
        await durableTransaction(async (client) => {
          const latest = await lockedRun(client, run.id);
          const current = await readRecord(run.id, row.image_id, client);
          const currentInput = await currentSource(row.image_id, client, true);
          if (!current || current.data.token !== token || latest.execution_token !== job.execution_token
            || latest.payload.desired_state !== "running" || !currentInput || !sameSource(source, currentInput)) {
            throw new Error("文件发布前的图片、任务或存储状态已变化");
          }
          publicationSignal.throwIfAborted();
          if (replacement) {
            const actual = await digestLocalFile(target, publicationSignal);
            if (actual.sha256 !== replacement.sha256) throw new Error("待替换的已知产物发生变化");
            await client.query(
              "UPDATE image_variant_preparation SET state='stale' WHERE image_id=$1 AND run_id<>$2 AND state='ready'", [row.image_id, run.id]
            );
          }
          // The expected facts already committed above remain recoverable even if COMMIT below is ambiguous.
          await publishLocalCandidate(candidate, target, { replaceOwned: Boolean(replacement), signal: publicationSignal });
          current.data.variants[variant]!.facts = encoded;
          await saveRecord(client, current);
          row = current;
        });
      }));
    }
    const latestSource = await currentSource(row.image_id);
    if (!latestSource) { await cleanDeletedPreparationImage(await historicalReceipts(row.image_id), signal); outcome = "excluded"; }
    else if (!sameSource(source, latestSource)) throw new Error("完成前图片原图或后端发生变化");
  } catch (error) {
    outcome = signal.aborted ? "interrupted" : "failed";
    message = signal.aborted ? "处理已停止，完整产物保留" : error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (["ENOSPC", "EACCES", "EROFS", "EDQUOT"].includes(code) || code.startsWith("08") || code === "57P01") fatal = error;
  } finally {
    // A completion receipt never implies a native child has already exited.
    await child?.close();
    const latest = await readRecord(run.id, row.image_id);
    if (latest?.data.cache_path) await rm(latest.data.cache_path, { recursive: true, force: true });
    await finishPreparationRecord(row, mode, outcome, message);
    if (outcome === "ready" && latest?.data.input) {
      await rm(latest.data.input.path, { force: true });
      await syncDirectory(dirname(latest.data.input.path));
    }
  }
  if (fatal) throw fatal;
}

async function recoverRunRecords(runId: string) {
  await assertPreviousChildrenExited(runId);
  await durableTransaction(async (client) => {
    const run = await lockedRun(client, runId);
    const rows = (await client.query<PreparationRecord>(
      "SELECT * FROM image_variant_preparation WHERE run_id=$1 AND state='running'", [runId]
    )).rows;
    for (const row of rows) {
      if (row.data.cache_path) await rm(row.data.cache_path, { recursive: true, force: true });
      row.state = run.payload.execution_mode === "verify" ? "ready" : "pending";
      row.data.token = null;
      row.data.child = null;
      row.data.phase = "重启恢复，等待核验已有产物";
      await saveRecord(client, row);
    }
    run.payload.owner = await processIdentity();
    await saveRun(client, run);
  });
}

async function reconcileDeletedFiles(runId: string, signal: AbortSignal) {
  const rows = (await pool.query<PreparationRecord>(
    `SELECT * FROM image_variant_preparation WHERE run_id=$1 AND state='excluded'
     AND (data->>'exclusion_cleaned') IS DISTINCT FROM 'true' ORDER BY image_id LIMIT 50`, [runId]
  )).rows;
  for (const row of rows) {
    signal.throwIfAborted();
    await cleanDeletedPreparationImage(await historicalReceipts(row.image_id), signal);
    await durableTransaction(async (client) => {
      await lockedRun(client, runId);
      const latest = await readRecord(runId, row.image_id, client);
      if (latest?.state === "excluded") { latest.data.exclusion_cleaned = true; await saveRecord(client, latest); }
    });
  }
  return rows.length;
}

export async function recoverPreparationJob() {
  await tryWithAdvisoryLocks([{ key: coordinatorLock }], async () => {
    const stale = (await pool.query<PreparationRun>(
      "SELECT id,status,execution_token,payload FROM background_job WHERE type='normalize.prepare' AND status='running' AND updated_at<clock_timestamp()-interval '20 seconds'"
    )).rows;
    for (const run of stale) {
      if (run.payload.owner && !await previousProcessExited(run.payload.owner)) continue;
      try { await assertPreviousChildrenExited(run.id); }
      catch { continue; }
      await pool.query(
        "UPDATE background_job SET status='pending',execution_token=NULL,updated_at=clock_timestamp() WHERE id=$1 AND execution_token=$2", [run.id, run.execution_token]
      );
    }
  });
}

export async function handlePreparationJob(job: BackgroundJob, signal: AbortSignal) {
  return runWithAdvisoryLockAcquisitionSignal(signal, () => withAdvisoryLock(coordinatorLock, async (lockSignal) => {
    const control = new AbortController();
    const executionSignal = AbortSignal.any([signal, lockSignal, control.signal]);
    const active = new Map<string, Promise<void>>();
    let failed: unknown;
    await recoverRunRecords(job.id);
    return withStorageLocationReadLock(async (storageSignal) => {
      const workSignal = AbortSignal.any([executionSignal, storageSignal]);
      try {
        while (true) {
          workSignal.throwIfAborted();
          const run = (await pool.query<PreparationRun>(
            "SELECT id,status,execution_token,payload FROM background_job WHERE id=$1", [job.id]
          )).rows[0]!;
          if (run.execution_token !== job.execution_token) throw new Error("预生成协调器执行权已失效");
          if (!preparationRunIsExecutable(run) && !run.payload.reconcile_requested) { control.abort(new Error("预生成已停止")); break; }
          if (!run.payload.enumerated) { await enumeratePreparation(run.id); continue; }
          if (!active.size && await reconcileDeletedFiles(run.id, workSignal)) continue;
          if (run.payload.reconcile_requested) await durableTransaction(async (client) => {
            const latest = await lockedRun(client, job.id);
            latest.payload.reconcile_requested = false;
            delete latest.payload.rerun_requested;
            await saveRun(client, latest);
          });
          if (!preparationRunIsExecutable(run)) { control.abort(new Error("预生成已停止")); break; }
          if (failed) throw failed;
          if (!active.size && run.payload.rest && !run.payload.rest.deadline) {
            await durableTransaction(async (client) => {
              const latest = await lockedRun(client, job.id);
              if (latest.payload.rest && !latest.payload.rest.deadline) {
                latest.payload.rest.deadline = (await client.query(
                  "SELECT clock_timestamp()+($1*interval '1 second') AS deadline", [latest.payload.rest.seconds]
                )).rows[0].deadline.toISOString();
                await saveRun(client, latest);
              }
            });
            continue;
          }
          if (active.size < run.payload.concurrency) {
            await assertPreparationSpace(Math.max(run.payload.concurrency, active.size), run.payload.max_output_bytes);
            const row = await claimPreparationRecord(job.id, job.execution_token);
            if (row) {
              const promise = processPicture(job, row, run, workSignal)
                .catch((error: unknown) => { failed = error; control.abort(error); })
                .finally(() => { active.delete(row.image_id); });
              active.set(row.image_id, promise);
              continue;
            }
          }
          if (!active.size) {
            const remaining = Number((await pool.query(
              `SELECT count(*) AS n FROM image_variant_preparation WHERE run_id=$1 AND
                (($2='generate' AND state='pending') OR ($2='verify' AND state='ready' AND (data->>'verified')::int<$3))`,
              [job.id, run.payload.execution_mode, run.payload.verification]
            )).rows[0].n);
            if (!remaining) {
              if (run.payload.execution_mode === "verify") await durableTransaction(async (client) => {
                const latest = await lockedRun(client, job.id);
                const incomplete = Number((await client.query(
                  `SELECT count(*) AS n FROM metadata m LEFT JOIN image_variant_preparation p
                     ON p.run_id=$1 AND p.image_id=m.id WHERE p.state IS DISTINCT FROM 'ready'
                     OR (p.data->>'verified')::int IS DISTINCT FROM $2
                     OR p.data->'source'->>'original' IS DISTINCT FROM m.original
                     OR p.data->'source'->>'storage_slug' IS DISTINCT FROM m.storage_slug`, [job.id, latest.payload.verification]
                )).rows[0].n);
                if (!incomplete) latest.payload.verified_at = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now.toISOString();
                await saveRun(client, latest);
              });
              break;
            }
          }
          await delay(500, undefined, { signal: workSignal });
        }
      } catch (error) {
        if (!signal.aborted && !lockSignal.aborted && (failed || !control.signal.aborted)) {
          const reason = failed ?? error;
          await durableTransaction(async (client) => {
            const latest = await lockedRun(client, job.id);
            latest.payload.block = reason instanceof Error ? reason.message : String(reason);
            await saveRun(client, latest);
          });
        }
        control.abort(error);
        if (signal.aborted || lockSignal.aborted) throw error;
      } finally {
        control.abort(new Error("预生成协调器收敛"));
        await Promise.allSettled(active.values());
      }
      return jobSucceeded();
    });
  }));
}
