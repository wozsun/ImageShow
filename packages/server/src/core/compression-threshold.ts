import type { Context } from "hono";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/compress";

const noTransformPattern = /(?:^|,)\s*no-transform\s*(?:,|$)/i;

/**
 * Gives Hono's compression middleware a real size for small responses without
 * cloning and fully draining every large response first. For a large stream the
 * temporary Content-Length only communicates that the threshold was reached;
 * callers must remove it when no content encoding was selected.
 */
export async function prepareCompressionThreshold(c: Context, threshold: number) {
  if (!c.res.body || c.req.method === "HEAD" || c.res.status === 206) return false;
  if (c.res.headers.has("Content-Length") || c.res.headers.has("Content-Encoding") || c.res.headers.has("Transfer-Encoding")) return false;
  if (noTransformPattern.test(c.res.headers.get("Cache-Control") ?? "")) return false;
  if (!COMPRESSIBLE_CONTENT_TYPE_REGEX.test(c.res.headers.get("Content-Type") ?? "")) return false;
  if (!/(?:^|,)\s*(?:gzip|deflate|\*)\s*(?:;|,|$)/i.test(c.req.header("Accept-Encoding") ?? "")) return false;

  const reader = c.res.body.getReader();
  const chunks: Uint8Array[] = [];
  let measuredLength = 0;
  let complete = false;

  while (measuredLength < threshold) {
    const chunk = await reader.read();
    if (chunk.done) {
      complete = true;
      break;
    }
    chunks.push(chunk.value);
    measuredLength += chunk.value.byteLength;
  }

  let replayIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (replayIndex < chunks.length) {
        controller.enqueue(chunks[replayIndex]);
        replayIndex += 1;
        return;
      }
      if (complete) {
        controller.close();
        return;
      }
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          complete = true;
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  const headers = new Headers(c.res.headers);
  headers.set("Content-Length", String(measuredLength));
  c.res = new Response(body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers
  });
  return !complete;
}
