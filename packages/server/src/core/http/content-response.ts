import { createHash } from "node:crypto";
import { conditionalRequestNotModified } from "./validators.ts";

export type ContentRepresentation = Readonly<{
  body: string;
  etag: string;
}>;

type ContentResponseOptions = {
  cacheControl: string;
  contentType: string;
  headers?: Readonly<Record<string, string>>;
  ifNoneMatch?: string | null;
};

/**
 * Build one stable semantic representation before compression chooses a wire
 * encoding. The weak validator therefore remains valid for identity, gzip and
 * Brotli variants without reading or cloning a response stream.
 */
export function createContentRepresentation(body: string): ContentRepresentation {
  return {
    body,
    etag: `W/"${createHash("sha256").update(body).digest("base64url")}"`
  };
}

export function contentResponse(
  representation: ContentRepresentation,
  options: ContentResponseOptions
) {
  const notModified = conditionalRequestNotModified({
    ifNoneMatch: options.ifNoneMatch,
    etag: representation.etag
  });
  return new Response(notModified ? null : representation.body, {
    status: notModified ? 304 : 200,
    headers: {
      ...(options.headers ?? {}),
      "Content-Type": options.contentType,
      "Cache-Control": options.cacheControl,
      ETag: representation.etag
    }
  });
}
