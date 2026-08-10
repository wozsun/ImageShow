import type { Context } from "hono";
import type { StoredResponseRequest } from "../images/serving.ts";

export function storedResponseRequest(
  context: Context
): StoredResponseRequest {
  return {
    range: context.req.header("range"),
    ifNoneMatch: context.req.header("if-none-match"),
    ifModifiedSince: context.req.header("if-modified-since"),
    ifRange: context.req.header("if-range"),
    isHead: context.req.method === "HEAD",
    signal: context.req.raw.signal
  };
}
