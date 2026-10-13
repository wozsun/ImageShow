import {
  unpackImageAddresses,
  type ApiErrorResponseDto
} from "@imageshow/shared/browser";
import {
  ApiClientError,
  fetchApi,
  parseApiResponse
} from "../../../../lib/api/client.js";

function readEventBlock(block: string) {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
}

/**
 * Send a request whose response is an SSE stream of `progress` events ending
 * with one `result` or one `error` (ApiErrorResponseDto) event. Unlike
 * EventSource, the request can carry a body and is cancelled by its signal.
 */
export async function apiProgressStream<T, Progress>(
  path: string,
  init: RequestInit,
  onProgress: (progress: Progress) => void
): Promise<T> {
  const response = await fetchApi(path, init);
  if (!response.ok || !response.body
    || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    await parseApiResponse(response);
    throw new ApiClientError("服务器响应不是事件流", response.status, "invalid_event_stream");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += chunk.value;
    let boundary = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const { event, data } = readEventBlock(buffered.slice(0, boundary));
      buffered = buffered.slice(boundary + 2);
      boundary = buffered.indexOf("\n\n");
      if (event === "progress") {
        onProgress(JSON.parse(data) as Progress);
      } else if (event === "result") {
        void reader.cancel();
        return unpackImageAddresses(JSON.parse(data)) as T;
      } else if (event === "error") {
        void reader.cancel();
        const failure = JSON.parse(data) as Partial<ApiErrorResponseDto>;
        throw new ApiClientError(
          typeof failure.error === "string" ? failure.error : "请求失败",
          response.status,
          typeof failure.code === "string" ? failure.code : "",
          failure.details ?? {}
        );
      }
    }
  }
  throw new ApiClientError("连接在结果返回前中断，请重试", response.status, "event_stream_interrupted");
}
