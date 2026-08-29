import {
  getRuntimeConfig,
  onRuntimeConfigChange
} from "../../../config/runtime-config-store.ts";
import { abortSignalError } from "../../../core/abort.ts";
import {
  DynamicConcurrencyLimiter,
  DynamicWeightedLimiter
} from "../../../core/concurrency.ts";

// Internal memory admission for prepared image plus thumbnail buffers. This is
// intentionally not deployment configuration: operators tune item concurrency,
// while the 2C4G baseline owns this invariant.
const INGESTION_COMMIT_BYTE_BUDGET_BYTES = 256 * 1024 * 1024;

const ingestionCommitAdmission = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().ingestion.commit_concurrency,
  (signal) => abortSignalError(signal, "Image commit aborted")
);
const ingestionCommitByteAdmission = new DynamicWeightedLimiter(
  () => INGESTION_COMMIT_BYTE_BUDGET_BYTES,
  (signal) => abortSignalError(signal, "Image commit aborted")
);

onRuntimeConfigChange(() => ingestionCommitAdmission.refresh());

export function ingestionCommitAdmissionSnapshot() {
  return {
    items: ingestionCommitAdmission.snapshot(),
    bytes: ingestionCommitByteAdmission.snapshot()
  } as const;
}

export function withIngestionCommitAdmission<Result>(
  bytes: number,
  signal: AbortSignal,
  work: () => Promise<Result>
) {
  return ingestionCommitAdmission.run(signal, () => (
    ingestionCommitByteAdmission.run(bytes, signal, work)
  ));
}
