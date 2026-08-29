import { abortSignalError } from "../../core/abort.ts";
import { DynamicConcurrencyLimiter } from "../../core/concurrency.ts";

export const STORAGE_MIGRATION_CONCURRENCY = 5;

const storageMigrationAdmission = new DynamicConcurrencyLimiter(
  () => STORAGE_MIGRATION_CONCURRENCY,
  (signal) => abortSignalError(signal, "Storage migration aborted")
);

export function withStorageMigrationAdmission<Result>(
  signal: AbortSignal,
  work: () => Promise<Result>
) {
  return storageMigrationAdmission.run(signal, work);
}
