import {
  getRuntimeConfig,
  onRuntimeConfigChange
} from "../../../config/runtime-config-store.ts";
import { abortSignalError } from "../../../core/abort.ts";
import { DynamicConcurrencyLimiter } from "../../../core/concurrency.ts";

const rawUploadAdmission = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().upload.raw_concurrency,
  (signal) => abortSignalError(signal, "Raw upload aborted")
);

onRuntimeConfigChange(() => rawUploadAdmission.refresh());

export function withRawUploadAdmission<Result>(
  signal: AbortSignal,
  work: () => Promise<Result>
) {
  return rawUploadAdmission.run(signal, work);
}
