import {
  adminApiBasePath,
  adminPreferencesMaxBytes,
  appConfig
} from "@imageshow/shared";
import type { Context, Next } from "hono";
import { cspReportPath, routeError } from "./http.ts";

const standardApiBodyMaxBytes = 128 * 1024;
const jsonlManifestBodyMaxBytes = appConfig.imports.jsonlManifestMaxBytes;
const advancedConfigMaxBytes =
  appConfig.imports.configPackageMaxBytes + 64 * 1024;
const adminPreferencesBodyMaxBytes = adminPreferencesMaxBytes + 1024;
const jsonlManifestPath = `${adminApiBasePath}/imports/jsonl/parse`;
const weiboImportPath = `${adminApiBasePath}/imports/weibo/parse`;
const importBatchCreatePath = `${adminApiBasePath}/imports/batch-create`;
// Fifty maximum-length URLs occupy about 600 KiB after worst-case JSON
// escaping. A 1 MiB tier accepts every legal request with finite headroom.
const weiboImportBodyMaxBytes = appConfig.imports.weiboRequestBodyMaxBytes;
// The schema accepts 3,600 items and its maximum-length fields can produce a
// JSON document of about 147.5 MiB after worst-case escaping. Use the next
// configured size tier so syntax and future compatible fields retain headroom.
const importBatchCreateBodyMaxBytes = 256 * 1024 * 1024;
export const batchImageUpdatePath = `${adminApiBasePath}/images/batch-update`;
// Two hundred maximum-field items occupy about 5.692 MiB after worst-case JSON
// escaping. The 6 MiB tier covers every legal request with finite headroom.
const batchImageUpdateBodyMaxBytes = 6 * 1024 * 1024;
const importFilePath = new RegExp(`^${adminApiBasePath}/imports/[^/]+/file$`);
const advancedConfigLargeBodyPath = new RegExp(
  `^${adminApiBasePath}/advanced-config/(?:preview|import|runtime(?:/validate)?)$`
);

function tooLarge(_c: Context) {
  return routeError({
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
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      c.set(requestBodyBytesContextKey, size);
      if (size > maxSize) return tooLarge(c);
      chunks.push(value);
    }

    const requestInit: RequestInit & { duplex: "half" } = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: "half",
    };
    c.req.raw = new Request(c.req.raw, requestInit);
    return next();
  };
}

export function getRequestBodyBytes(c: Context) {
  const measured = c.get(requestBodyBytesContextKey) as number | undefined;
  if (Number.isFinite(measured)) return measured ?? 0;
  const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10);
  return Number.isFinite(declared) ? Math.max(0, declared) : 0;
}

const limitStandardApiBody = measuredBodyLimit(standardApiBodyMaxBytes);

export const limitJsonlManifestBody = measuredBodyLimit(jsonlManifestBodyMaxBytes);

export const limitWeiboImportBody = measuredBodyLimit(weiboImportBodyMaxBytes);

export const limitImportBatchCreateBody = measuredBodyLimit(importBatchCreateBodyMaxBytes);

const limitConfigPackageBody = measuredBodyLimit(advancedConfigMaxBytes);

export const limitBatchImageUpdateBody = measuredBodyLimit(batchImageUpdateBodyMaxBytes);

export const limitAdminPreferencesBody = measuredBodyLimit(adminPreferencesBodyMaxBytes);

export function limitApiRequestBody(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path === cspReportPath) {
    // 浏览器报告端点默认只用于满足 Reporting API 的投递要求；路由不会
    // 消费正文，因此这里也跳过分块请求的预读和重建，保持固定开销。
    return next();
  }
  if (
    path === jsonlManifestPath
    || path === weiboImportPath
    || path === importBatchCreatePath
    || (c.req.method === "PUT" && importFilePath.test(path))
  ) {
    return next();
  }
  if (c.req.method === "POST" && path === batchImageUpdatePath) {
    return next();
  }
  if (c.req.method === "POST" && advancedConfigLargeBodyPath.test(path)) {
    return limitConfigPackageBody(c, next);
  }
  return limitStandardApiBody(c, next);
}
