import type { Context } from "hono";
import { ApiError } from "../api-error.ts";

const jsonMediaTypePattern = /^application\/(?:[!#$%&'*+.^_`|~0-9a-z-]+\+)?json$/i;

export function invalidJsonBodyError() {
  return new ApiError(
    400,
    "invalid_json",
    "Request body must contain valid JSON"
  );
}

export function isJsonContentType(value: string | undefined) {
  const mediaType = value?.split(";", 1)[0]?.trim() ?? "";
  return jsonMediaTypePattern.test(mediaType);
}

/**
 * Reads one JSON request body under a stable wire contract. Route schemas own
 * the decoded value; this helper only validates the media type, body presence,
 * transport completion, and JSON syntax.
 */
export async function readJsonBody(context: Context): Promise<unknown> {
  if (!isJsonContentType(context.req.header("content-type"))) {
    throw invalidJsonBodyError();
  }

  const signal = context.req.raw.signal;
  if (signal.aborted) throw invalidJsonBodyError();

  try {
    const text = await context.req.text();
    if (signal.aborted || !text.trim()) throw invalidJsonBodyError();
    const value: unknown = JSON.parse(text);
    if (signal.aborted) throw invalidJsonBodyError();
    return value;
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_json") {
      throw error;
    }
    throw invalidJsonBodyError();
  }
}
