import { Context as HonoContext, type Context, type Handler } from "hono";
import { conditionalRequestNotModified, ifRangeMatches } from "./http-validator.ts";
import { parseSingleByteRange } from "../storage/byte-range.ts";

/** @internal Exported only for static Range validator verification. */
export function staticEtag(headers: Headers) {
  const modified = headers.get("Last-Modified");
  const contentRange = headers.get("Content-Range");
  const rangeTotal = contentRange?.match(/^bytes\s+\d+-\d+\/(\d+)$/i)?.[1];
  const length = rangeTotal ?? headers.get("Content-Length");
  const modifiedTime = modified ? new Date(modified).getTime() : Number.NaN;
  const resourceLength = length === null ? Number.NaN : Number(length);
  if (!Number.isFinite(modifiedTime) || !Number.isSafeInteger(resourceLength) || resourceLength < 0) return "";
  const encoding = headers.get("Content-Encoding") ?? "identity";
  return `W/"${modifiedTime.toString(16)}-${resourceLength.toString(16)}-${encoding}"`;
}

function requestWithRange(request: Request, range?: string) {
  const headers = new Headers(request.headers);
  if (range) headers.set("Range", range);
  else headers.delete("Range");
  return new Request(request, { headers });
}

async function invokeStaticHandler(c: Context, handler: Handler) {
  const previousResponse = c.res;
  const response = await handler(c, async () => undefined);
  if (response) c.res = response;
  return response || c.res !== previousResponse ? c.res : undefined;
}

function applyStaticEtag(response: Response) {
  const etag = staticEtag(response.headers);
  if (etag) response.headers.set("ETag", etag);
  return etag;
}

function adoptStaticResponse(c: Context, response: Response) {
  // Materialize prepared outer-middleware headers before replacing c.res;
  // Hono otherwise does not merge them when no response object exists yet.
  void c.res;
  c.res = response;
  return c.res;
}

async function cancelResponseBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Serves one static resource with shared conditional and single-range rules.
 * Range requests are first resolved without Range so suffix and invalid ranges
 * can be normalized before the Node adapter opens a partial file stream.
 */
export async function serveStaticWithValidators(c: Context, handler: Handler) {
  const originalRequest = c.req.raw;
  const method = c.req.method;
  const requestedRange = method === "GET" ? originalRequest.headers.get("range") ?? undefined : undefined;
  try {
    // A separate context keeps the real request unfinalized. The Node static
    // adapter refuses a second invocation once a response has finalized it.
    const fullContext = requestedRange
      ? new HonoContext(requestWithRange(originalRequest), {
          env: c.env,
          path: c.req.path
        })
      : c;
    const fullResponse = await invokeStaticHandler(fullContext, handler);
    if (!fullResponse) return undefined;
    if ((method !== "GET" && method !== "HEAD") || fullResponse.status < 200 || fullResponse.status >= 300) {
      return fullContext !== c ? adoptStaticResponse(c, fullResponse) : fullResponse;
    }

    const etag = applyStaticEtag(fullResponse);
    const lastModified = fullResponse.headers.get("Last-Modified");
    if (conditionalRequestNotModified({
      ifNoneMatch: originalRequest.headers.get("if-none-match"),
      ifModifiedSince: originalRequest.headers.get("if-modified-since"),
      etag,
      lastModified
    })) {
      await cancelResponseBody(fullResponse);
      const headers = new Headers(fullResponse.headers);
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");
      headers.delete("Content-Range");
      const response = new Response(null, { status: 304, headers });
      response.headers.delete("Content-Length");
      response.headers.delete("Content-Encoding");
      const adopted = adoptStaticResponse(c, response);
      adopted.headers.delete("Content-Length");
      adopted.headers.delete("Content-Encoding");
      adopted.headers.delete("Content-Range");
      return adopted;
    }

    if (!requestedRange || !ifRangeMatches(originalRequest.headers.get("if-range"), {
      etag,
      lastModified: lastModified ?? undefined
    })) {
      return fullContext !== c ? adoptStaticResponse(c, fullResponse) : fullResponse;
    }

    const totalSize = Number(fullResponse.headers.get("Content-Length"));
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
      return adoptStaticResponse(c, fullResponse);
    }
    let range;
    try {
      range = parseSingleByteRange(requestedRange, totalSize);
    } catch (error) {
      await cancelResponseBody(fullResponse);
      throw error;
    }
    if (!range) return adoptStaticResponse(c, fullResponse);

    await cancelResponseBody(fullResponse);
    c.req.raw = requestWithRange(originalRequest, `bytes=${range.start}-${range.end}`);
    const rangeResponse = await invokeStaticHandler(c, handler);
    if (!rangeResponse) return undefined;
    applyStaticEtag(rangeResponse);
    return rangeResponse;
  } finally {
    c.req.raw = originalRequest;
  }
}
