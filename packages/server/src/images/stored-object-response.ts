import { ifNoneMatchMatches, ifRangeMatches } from "../core/http/validators.ts";
import type { OpenedRead } from "../storage/driver.ts";
import type { ResolvedReadableObject } from "../storage/object-access.ts";
import { webReadableFromNode } from "../storage/stream-buffer.ts";

export type StoredResponseRequest = {
  range?: string;
  ifNoneMatch?: string;
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

export async function streamResolvedObject(
  object: ResolvedReadableObject,
  contentTypeValue: string,
  cacheControl: string,
  request: StoredResponseRequest = {}
) {
  const validateBeforeRange = Boolean(
    request.range && (request.ifNoneMatch || request.ifRange)
  );
  let opened = await object.open(
    validateBeforeRange ? undefined : request.range
  );
  if (ifNoneMatchMatches(request.ifNoneMatch, opened.etag)) {
    opened.body.destroy();
    const headers = new Headers({
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes"
    });
    if (opened.etag) headers.set("ETag", opened.etag);
    if (opened.lastModified) {
      headers.set("Last-Modified", opened.lastModified);
    }
    return new Response(null, { status: 304, headers });
  }

  const shouldApplyRange = Boolean(
    request.range
    && (!request.ifRange || ifRangeMatches(request.ifRange, opened))
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

  const headers = new Headers({
    "Content-Type": contentTypeValue,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes"
  });
  if (opened.etag) headers.set("ETag", opened.etag);
  if (opened.lastModified) {
    headers.set("Last-Modified", opened.lastModified);
  }
  if (opened.size !== undefined) {
    headers.set("Content-Length", String(opened.size));
  }
  if (opened.contentRange) {
    headers.set("Content-Range", opened.contentRange);
  }
  if (request.isHead) opened.body.destroy();
  return new Response(request.isHead ? null : webReadableFromNode(opened.body), {
    status: opened.contentRange ? 206 : 200,
    headers
  });
}
