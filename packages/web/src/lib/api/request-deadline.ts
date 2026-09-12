// 回调必须完成响应体读取；只限制单次请求，不提供重试或服务端取消保证。
export async function requestWithDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => {
    controller.abort(new DOMException("请求响应超时", "TimeoutError"));
  }, 30_000);
  try {
    return await request(requestSignal);
  } catch (error) {
    // HTTP 错误可能在正文仍传输时抛出。结束逻辑任务前同时释放底层请求，
    // 保留原始错误，不能把 HTTP / 解析失败改判为可重试的传输故障。
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
