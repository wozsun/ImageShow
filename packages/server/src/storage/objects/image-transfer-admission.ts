import { abortSignalError } from "../../core/abort.ts";
import { DynamicConcurrencyLimiter } from "../../core/concurrency.ts";

export const IMAGE_TRANSFER_CONCURRENCY = 5;

const imageTransferAdmission = new DynamicConcurrencyLimiter(
  () => IMAGE_TRANSFER_CONCURRENCY,
  (signal) => abortSignalError(signal, "Storage migration aborted")
);

export function withImageTransferAdmission<Result>(
  signal: AbortSignal,
  work: () => Promise<Result>
) {
  return imageTransferAdmission.run(signal, work);
}
