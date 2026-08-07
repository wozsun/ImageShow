import {
  conditionalRequestNotModified,
  ifRangeMatches
} from "../core/http/validators.ts";
import type { OpenedRead } from "../storage/driver.ts";
import type { ResolvedReadableObject } from "../storage/object-access.ts";
import { webReadableFromNode } from "../storage/stream-buffer.ts";
import {
  responseContentLengthValue,
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import { normalizePartialContentRange } from "../core/http/byte-range.ts";
import { ApiError } from "../core/api-error.ts";

export type StoredResponseRequest = {
  range?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  ifRange?: string;
  isHead?: boolean;
};

function sameObjectVersion(left: OpenedRead, right: OpenedRead) {
  if (left.etag || right.etag) {
    return Boolean(left.etag && right.etag && left.etag === right.etag);
  }
  return Boolean(
    left.lastModified
    && right.lastModified
    && left.lastModified === right.lastModified
    && left.totalSize !== undefined
    && left.totalSize === right.totalSize
  );
}

function safeStoredEtag(value?: string) {
  if (!value) return undefined;
  try {
    return safeResponseHeaderValue("ETag", value);
  } catch {
    return undefined;
  }
}

function safeStoredLastModified(value?: string) {
  if (!value) return undefined;
  try {
    const safeValue = safeResponseHeaderValue("Last-Modified", value);
    const timestamp = Date.parse(safeValue);
    return Number.isFinite(timestamp)
      ? new Date(timestamp).toUTCString()
      : undefined;
  } catch {
    return undefined;
  }
}

export async function streamResolvedObject(
  object: ResolvedReadableObject,
  contentTypeValue: string,
  cacheControl: string,
  request: StoredResponseRequest = {}
) {
  const validateBeforeRange = Boolean(
    request.range
    && (request.ifNoneMatch || request.ifModifiedSince || request.ifRange)
  );
  let opened = await object.open(
    validateBeforeRange ? undefined : request.range
  );
  const initialEtag = safeStoredEtag(opened.etag);
  const initialLastModified = safeStoredLastModified(opened.lastModified);
  if (conditionalRequestNotModified({
    ifNoneMatch: request.ifNoneMatch,
    ifModifiedSince: request.ifModifiedSince,
    etag: initialEtag,
    lastModified: initialLastModified
  })) {
    opened.body.destroy();
    const headers = new Headers({
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes"
    });
    if (initialEtag) {
      headers.set("ETag", initialEtag);
    }
    if (initialLastModified) {
      headers.set("Last-Modified", initialLastModified);
    }
    return new Response(null, { status: 304, headers });
  }

  const shouldApplyRange = Boolean(
    request.range
    && (!request.ifRange || ifRangeMatches(request.ifRange, {
      etag: initialEtag,
      lastModified: initialLastModified
    }))
  );
  if (validateBeforeRange && shouldApplyRange) {
    const full = opened;
    full.body.destroy();
    opened = await object.open(request.range);
    if (!sameObjectVersion(full, opened)) {
      opened.body.destroy();
      opened = await object.open();
    }
  }

  const etag = safeStoredEtag(opened.etag);
  const lastModified = safeStoredLastModified(opened.lastModified);
  const contentRange = normalizePartialContentRange(opened.contentRange);
  if (opened.contentRange && !contentRange) {
    opened.body.destroy();
    throw new ApiError(
      502,
      "storage_read_failed",
      "Storage returned an invalid Content-Range"
    );
  }
  const headers = new Headers({
    "Content-Type": contentTypeValue,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes"
  });
  if (etag) {
    headers.set("ETag", etag);
  }
  if (lastModified) {
    headers.set("Last-Modified", lastModified);
  }
  const contentLength = responseContentLengthValue(opened.size);
  if (contentLength !== undefined) {
    headers.set("Content-Length", contentLength);
  }
  if (contentRange) {
    headers.set("Content-Range", contentRange);
  }
  if (request.isHead) opened.body.destroy();
  return new Response(request.isHead ? null : webReadableFromNode(opened.body), {
    status: contentRange ? 206 : 200,
    headers
  });
}
