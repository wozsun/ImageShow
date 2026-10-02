import { appConfig } from "@imageshow/shared";
import {
  adminApiBasePath,
  adminPreferencesMaxBytes,
  ingestionActionPath,
  ingestionCancelPath,
  ingestionCommitPath,
  ingestionDuplicatesPath,
  ingestionSnapshotPath,
  ingestionStatusPath,
  ingestionUpdatePath,
  importAcceptPath,
  importJsonlParsePath,
  importWeiboParsePath,
  uploadIntentPath,
  uploadRawPath
} from "@imageshow/shared/browser";
import type { Context, Next } from "hono";
import { apiErrorResponse } from "./responses.ts";
import {
  invalidJsonBodyError,
  isJsonContentType
} from "./json-body.ts";

const standardApiBodyMaxBytes = 128 * 1024;
const jsonlManifestBodyMaxBytes = appConfig.ingestion.jsonlManifestMaxBytes;
const adminPreferencesBodyMaxBytes = adminPreferencesMaxBytes + 1024;
const adminPreferencesPath = `${adminApiBasePath}/preferences`;
// Fifty maximum-length URLs occupy about 600 KiB after worst-case JSON
// escaping. A 1 MiB tier accepts every legal request with finite headroom.
const weiboImportBodyMaxBytes = appConfig.ingestion.weiboRequestBodyMaxBytes;
export const imageUpdatePath = `${adminApiBasePath}/images/update`;
// Two hundred maximum-field items occupy about 5.692 MiB after worst-case JSON
// escaping. The 6 MiB tier covers every legal request with finite headroom.
const imageUpdateBodyMaxBytes = 6 * 1024 * 1024;
// A legal 3,600-item batch can contain two 2 KiB URLs plus metadata and fifty
// tags per item. Keep even worst-case JSON escaping bounded without rejecting
// an otherwise valid configured ingestion batch.
const ingestionControlBodyMaxBytes = 160 * 1024 * 1024;
// One bounded 3,600-pair exclusion list plus the visible inclusion subset stay
// well below 1 MiB. Keep snapshot selection independent from the much larger
// metadata-bearing ingestion control tier.
const ingestionSnapshotBodyMaxBytes = 1024 * 1024;
function tooLarge(_c: Context) {
  return apiErrorResponse({
    status: 413,
    code: "request_body_too_large",
    message: "Request body too large"
  });
}

const requestBodyBytesContextKey = "requestBodyBytes";

/**
 * Hono's body limiter does not expose the number of bytes it inspected. This
 * equivalent limiter records that count for summary logs without parsing,
 * retaining, or logging the request body itself.
 */
function measuredBodyLimit(maxSize: number) {
  return async (c: Context, next: Next) => {
    if (!c.req.raw.body) {
      c.set(requestBodyBytesContextKey, 0);
      return next();
    }

    const hasTransferEncoding = c.req.raw.headers.has("transfer-encoding");
    const rawContentLength = c.req.raw.headers.get("content-length");
    if (rawContentLength !== null && !hasTransferEncoding) {
      const parsedContentLength = Number.parseInt(rawContentLength, 10);
      const contentLength = Number.isFinite(parsedContentLength)
        ? Math.max(0, parsedContentLength)
        : 0;
      c.set(requestBodyBytesContextKey, contentLength);
      return contentLength > maxSize ? tooLarge(c) : next();
    }

    let size = 0;
    const chunks: Uint8Array[] = [];
    const reader = c.req.raw.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        c.set(requestBodyBytesContextKey, size);
        if (size > maxSize) return tooLarge(c);
        chunks.push(value);
      }
    } catch (error) {
      if (c.req.raw.signal.aborted
        || isJsonContentType(c.req.header("content-type"))) {
        throw invalidJsonBodyError();
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    const requestInit: RequestInit & { duplex: "half" } = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      }),
      duplex: "half"
    };
    c.req.raw = new Request(c.req.raw, requestInit);
    return next();
  };
}

export function getRequestBodyBytes(c: Context) {
  const measured = c.get(requestBodyBytesContextKey);
  if (measured !== undefined && Number.isFinite(measured)) return measured;
  const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10);
  return Number.isFinite(declared) ? Math.max(0, declared) : 0;
}

const limitStandardApiBody = measuredBodyLimit(standardApiBodyMaxBytes);

export const limitAdminLoginBody = limitStandardApiBody;

const limitIngestionControlBody = measuredBodyLimit(ingestionControlBodyMaxBytes);
// Select each protected body tier after session and CSRF checks.
// Route handlers need neither a second limit nor a separate exemption list.
const protectedBodyLimits = new Map([
  [`POST ${imageUpdatePath}`, measuredBodyLimit(imageUpdateBodyMaxBytes)],
  [`PATCH ${adminPreferencesPath}`, measuredBodyLimit(adminPreferencesBodyMaxBytes)],
  [`POST ${uploadIntentPath}`, limitIngestionControlBody],
  [`POST ${importAcceptPath}`, limitIngestionControlBody],
  [`POST ${ingestionStatusPath}`, limitIngestionControlBody],
  [`POST ${ingestionDuplicatesPath}`, limitIngestionControlBody],
  [`POST ${ingestionUpdatePath}`, limitIngestionControlBody],
  [`POST ${ingestionActionPath}`, limitIngestionControlBody],
  [`POST ${ingestionCommitPath}`, limitIngestionControlBody],
  [`POST ${ingestionCancelPath}`, limitIngestionControlBody],
  [`POST ${ingestionSnapshotPath}`, measuredBodyLimit(ingestionSnapshotBodyMaxBytes)],
  [`POST ${importJsonlParsePath}`, measuredBodyLimit(jsonlManifestBodyMaxBytes)],
  [`POST ${importWeiboParsePath}`, measuredBodyLimit(weiboImportBodyMaxBytes)]
]);

export function limitApiRequestBody(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith(`${adminApiBasePath}/`)) {
    // Admin routes select their body tier after same-origin checks or session
    // authentication. This also keeps anonymous large requests off the body.
    return next();
  }
  return limitStandardApiBody(c, next);
}

export function limitProtectedAdminRequestBody(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (c.req.method === "PUT" && path === uploadRawPath) {
    return next();
  }
  const limit = protectedBodyLimits.get(`${c.req.method} ${path}`);
  if (limit) return limit(c, next);
  return limitStandardApiBody(c, next);
}
