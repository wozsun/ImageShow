import {
  getRuntimeConfig,
  onRuntimeConfigChange
} from "../config/runtime-config-store.ts";
import { abortSignalError } from "../core/abort.ts";
import { DynamicConcurrencyLimiter } from "../core/concurrency.ts";

const normalizationAdmission = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().normalize.concurrency,
  (signal) => abortSignalError(signal, "Image normalization aborted")
);

onRuntimeConfigChange(() => normalizationAdmission.refresh());

export function withNormalizationAdmission<Result>(
  signal: AbortSignal,
  work: () => Promise<Result>
) {
  return normalizationAdmission.run(signal, work);
}
