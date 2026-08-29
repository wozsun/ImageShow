import { abortSignalError } from "../../core/abort.ts";
import { DynamicConcurrencyLimiter } from "../../core/concurrency.ts";

export const STORAGE_OBJECT_REMOVAL_CONCURRENCY = 1;

const storageObjectRemovalAdmission = new DynamicConcurrencyLimiter(
  () => STORAGE_OBJECT_REMOVAL_CONCURRENCY,
  (signal) => abortSignalError(signal, "Storage object removal aborted")
);

export function withStorageObjectRemovalAdmission<Result>(
  signal: AbortSignal,
  work: () => Promise<Result>
) {
  return storageObjectRemovalAdmission.run(signal, work);
}
