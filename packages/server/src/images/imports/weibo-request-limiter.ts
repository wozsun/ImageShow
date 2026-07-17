import { DynamicConcurrencyLimiter } from "../../core/concurrency.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";

const neverAbortedSignal = new AbortController().signal;
const weiboRequestLimiter = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().weibo.global_concurrency,
  (signal) => signal.reason ?? new DOMException("The operation was aborted", "AbortError")
);

export function runWeiboRequestWithinGlobalLimit<Result>(
  signal: AbortSignal | undefined,
  request: () => Promise<Result>
) {
  return weiboRequestLimiter.run(signal ?? neverAbortedSignal, request);
}
