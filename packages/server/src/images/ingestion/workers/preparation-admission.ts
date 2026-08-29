import {
  getRuntimeConfig,
  onRuntimeConfigChange
} from "../../../config/runtime-config-store.ts";
import { abortSignalError } from "../../../core/abort.ts";
import { DynamicConcurrencyLimiter } from "../../../core/concurrency.ts";

/**
 * The single process-wide owner shared by Upload and Import for work that can
 * retain processed image buffers while staging them. Its capacity follows the
 * sole public Normalize setting, but remains held after CPU normalization
 * releases its shared permit and until the ready canonical references both
 * published staging objects.
 */
const ingestionPreparationAdmission = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().normalize.concurrency,
  (signal) => abortSignalError(signal, "Image preparation aborted")
);

onRuntimeConfigChange(() => ingestionPreparationAdmission.refresh());

export function ingestionPreparationAdmissionSnapshot() {
  return ingestionPreparationAdmission.snapshot();
}

export function withIngestionPreparationAdmission<Result>(
  signal: AbortSignal,
  work: () => Promise<Result>
) {
  return ingestionPreparationAdmission.run(signal, work);
}
