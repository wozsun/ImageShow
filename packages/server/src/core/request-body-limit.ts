import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";
import { routeError } from "./http.ts";

const standardApiBodyMaxBytes = 64 * 1024;
const jsonlManifestBodyMaxBytes = appConfig.imports.jsonlManifestMaxBytes;
const jsonlManifestPath = `${adminApiBasePath}/imports/jsonl/parse`;
const importFilePath = new RegExp(`^${adminApiBasePath}/imports/[^/]+/file$`);

function tooLarge(_c: Context) {
  return routeError({
    status: 413,
    code: "request_body_too_large",
    message: "Request body too large"
  });
}

const limitStandardApiBody = bodyLimit({
  maxSize: standardApiBodyMaxBytes,
  onError: tooLarge
});

export const limitJsonlManifestBody = bodyLimit({
  maxSize: jsonlManifestBodyMaxBytes,
  onError: tooLarge
});

export function limitApiRequestBody(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path === jsonlManifestPath || (c.req.method === "PUT" && importFilePath.test(path))) {
    return next();
  }
  return limitStandardApiBody(c, next);
}
