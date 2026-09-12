import { isApiClientError } from "./client.js";

// 仅供明确只读的 API 使用；Query 查询直接采用此策略，不再在 queryFn 内套重试。
export const readRequestRetryOptions = {
  retry(failureCount: number, error: unknown) {
    if (failureCount >= 3) return false;
    if (isApiClientError(error)) {
      return [408, 500, 502, 503, 504].includes(error.status);
    }
    // 浏览器 fetch 的网络失败以 TypeError 拒绝；取消和其他异常不重试。
    return error instanceof TypeError;
  },
  retryDelay(failureCount: number) {
    return 500 * 2 ** failureCount;
  }
};

function waitForRetry(delayMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 无 Query owner 的只读快照复用同一失败判定与退避，取消同时终止请求和等待。
export async function retryReadRequest<T>(
  request: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  for (let failureCount = 0; ; failureCount += 1) {
    signal?.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      signal?.throwIfAborted();
      if (!readRequestRetryOptions.retry(failureCount, error)) throw error;
      await waitForRetry(readRequestRetryOptions.retryDelay(failureCount), signal);
    }
  }
}
