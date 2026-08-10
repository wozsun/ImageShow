import { withImageStorageMutationLock } from "./maintenance-lock.ts";
import type {
  StorageMigrationImageRecord,
  StorageMigrationResult
} from "./image-storage-migration-contract.ts";
import { prepareImageStorageMigration } from "./image-storage-migration-prepare.ts";
import {
  switchPreparedImageStorageMigration
} from "./image-storage-migration-switch.ts";

export type {
  StorageMigrationImageRecord,
  StorageMigrationResult
} from "./image-storage-migration-contract.ts";

export function migrateImageStorageBackend(
  row: StorageMigrationImageRecord,
  target: string,
  options: { expectedSource?: string } = {}
): Promise<StorageMigrationResult> {
  return withImageStorageMutationLock(row.id, async (signal) => {
    const preparation = await prepareImageStorageMigration(
      row,
      target,
      options.expectedSource,
      signal
    );
    if (preparation.status !== "prepared") return preparation.status;
    return switchPreparedImageStorageMigration(
      preparation.migration,
      signal
    );
  });
}
