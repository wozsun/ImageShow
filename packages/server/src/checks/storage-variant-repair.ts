import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { storageObjectKey } from "@imageshow/shared/browser";
import { errorMessage } from "../core/api-error.ts";
import { pool } from "../core/database/pools.ts";
import { imageVariantColumns, storedVariantFacts, type ImageVariantRecord } from "../images/variants/record.ts";
import { verifyVariantFile } from "../images/variants/encoding.ts";
import { withVariantScratch } from "../images/variants/scratch.ts";
import { withNormalizationAdmission } from "../images/normalization-admission.ts";
import { listStorageBackends, resolveStorageAccess } from "../storage/backends/registry.ts";
import { assertObjectNotPendingCleanup } from "../storage/cleanup/service.ts";
import { verifyStorageTarget, writeVerifiedFileToStorage, type StorageAccess } from "../storage/objects/transfer.ts";
import { shareStorageNamespace } from "../storage/objects/namespace.ts";
import type { StoragePrefix } from "../storage/objects/keys.ts";
import type { MaintenanceImage, MaintenanceItem } from "./storage-maintenance-plan.ts";

async function readVerifiedVariant(
  storage: StorageAccess,
  prefix: StoragePrefix,
  key: string,
  expected: ReturnType<typeof storedVariantFacts>,
  path: string,
  signal: AbortSignal
) {
  const opened = await storage.driver.openRead(prefix, key, undefined, { signal });
  let bytes = 0;
  await pipeline(opened.body, new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    done(bytes > expected.byte_size ? new Error("对象超过登记体积") : null, chunk);
  } }), createWriteStream(path, { mode: 0o600 }), { signal });
  const facts = await withNormalizationAdmission(signal, () => verifyVariantFile(path, signal));
  if (facts.bytes !== expected.byte_size || facts.md5 !== expected.md5 || facts.width !== expected.width || facts.height !== expected.height) {
    throw new Error("对象与数据库登记内容不一致，请保留副本并从备份恢复");
  }
  return facts;
}

/** The caller holds the global storage location write lock through publication. */
export async function repairStorageVariant(imageId: string, prefix: StoragePrefix, scheduleSignal: AbortSignal, signal = scheduleSignal): Promise<MaintenanceItem> {
  const key = storageObjectKey(imageId);
  let backend = "unknown";
  const result = (outcome: MaintenanceItem["outcome"], details: Partial<MaintenanceItem> = {}): MaintenanceItem => ({ action: "repair_variant", outcome, backend, prefix, key, image_id: imageId, ...details });
  try {
    scheduleSignal.throwIfAborted();
    signal.throwIfAborted();
    const row = (await pool.query<MaintenanceImage & ImageVariantRecord>(`
      SELECT id, status, storage_slug, ${imageVariantColumns},
             status='deleted' AND EXISTS (SELECT 1 FROM background_job
                      WHERE type='trash.purge' AND target_id=metadata.id::text) AS purging
        FROM metadata WHERE id=$1`, [imageId])).rows[0];
    if (!row || !["ready", "deleted"].includes(row.status)) return result("skipped", { reason: "图片记录已不再保留" });
    backend = row.storage_slug;
    if (row.purging) return result("skipped", { reason: "图片由永久删除任务处理" });
    const target = await resolveStorageAccess(backend);
    await assertObjectNotPendingCleanup(target.config, prefix, key);
    const expected = storedVariantFacts(row, prefix);
    return await withVariantScratch(async (directory) => {
      const path = join(directory, "replica.webp");
      if (await target.driver.exists(prefix, key, { signal })) {
        await readVerifiedVariant(target, prefix, key, expected, path, signal);
        await target.driver.ensureDurable?.(prefix, key, { signal });
        return result("skipped", { reason: "当前位置对象已完整核验" });
      }
      const backends = await listStorageBackends();
      const failures: string[] = [];
      for (const candidate of backends) {
        signal.throwIfAborted();
        if (candidate.slug === backend) continue;
        try {
          const source = await resolveStorageAccess(candidate.slug);
          if (shareStorageNamespace(source.config, target.config)) continue;
          if (!(await source.driver.exists(prefix, key, { signal }))) continue;
          const facts = await readVerifiedVariant(source, prefix, key, expected, path, signal);
          await writeVerifiedFileToStorage({
            target: await verifyStorageTarget({ storage: target, prefix, key, expected: { size: facts.bytes, sha256: facts.sha256, md5: facts.md5 }, signal }),
            sourcePath: path,
            // A repair writes the referenced location, never an orphan. Retain
            // uncertain bytes; later maintenance revalidates them before any
            // source replica can be removed, without a competing delete lease.
            contentType: "image/webp", signal
          });
          return result("repaired", { byte_size: facts.bytes });
        } catch (error) {
          signal.throwIfAborted();
          failures.push(`${candidate.slug}: ${errorMessage(error)}`);
        }
      }
      return result("failed", { error: `没有可核验的一致副本，请从备份恢复 ${prefix}/${key}${failures.length ? `；${failures.join("；")}` : ""}` });
    });
  } catch (error) {
    signal.throwIfAborted();
    return result("failed", { error: errorMessage(error) });
  }
}
