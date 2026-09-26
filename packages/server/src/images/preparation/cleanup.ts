import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { imageVariants } from "@imageshow/shared/browser";
import { digestLocalFile, syncDirectory } from "../../storage/drivers/local-publication.ts";
import { withImageStorageMutationLock } from "../../storage/maintenance-lock.ts";
import { runWithAdvisoryLockAcquisitionSignal } from "../../core/database/advisory-locks.ts";
import { currentSource } from "./repository.ts";
import { preparationTarget } from "./paths.ts";
import type { PreparationRecord } from "./model.ts";

/** Exclusion keeps receipts but removes only files proved to belong to the deleted image. */
export async function cleanDeletedPreparationImage(records: PreparationRecord[], signal: AbortSignal) {
  const image = records[0]?.image_id;
  if (!image) return;
  await runWithAdvisoryLockAcquisitionSignal(signal, () => withImageStorageMutationLock(image, async (lockSignal) => {
    const operationSignal = AbortSignal.any([signal, lockSignal]);
    if (await currentSource(image)) return;
    for (const variant of imageVariants) {
      operationSignal.throwIfAborted();
      const target = preparationTarget(image, variant);
      const actual = await digestLocalFile(target, operationSignal).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const known = records.some((row) => {
        const receipt = row.data.variants[variant];
        return [receipt?.facts, receipt?.expected, receipt?.replaced?.facts].some((facts) =>
          facts && actual && facts.sha256 === actual.sha256 && facts.bytes === actual.bytes);
      });
      if (known) { await rm(target); await syncDirectory(dirname(target)); }
      for (const row of records) {
        const candidate = row.data.variants[variant]?.candidate;
        if (candidate) { await rm(candidate, { force: true }); await syncDirectory(dirname(candidate)); }
      }
    }
    for (const row of records) {
      if (row.data.input) await rm(row.data.input.path, { force: true });
      if (row.data.cache_path) await rm(row.data.cache_path, { recursive: true, force: true });
    }
  }));
}
