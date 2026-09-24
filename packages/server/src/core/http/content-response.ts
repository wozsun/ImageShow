import { conditionalRequestNotModified, entityTagDigest } from "./validators.ts";

export type ContentRepresentation = Readonly<{
  body: string | Uint8Array<ArrayBuffer>;
  byteLength: number;
  etag: string;
  encoding?: string;
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
    byteLength: Buffer.byteLength(body, "utf8"),
    etag: `W/"${entityTagDigest(body)}"`
  };
}

/** One published source snapshot and its response; never retain source history. */
export function createContentSnapshot<T extends object>(render: (snapshot: T) => string) {
  let cached: { source: T; representation: ContentRepresentation } | undefined;
  return (source: T): ContentRepresentation => {
    if (cached?.source === source) return cached.representation;
    const body = render(source);
    const representation =
      cached?.representation.body === body
        ? cached.representation
        : createContentRepresentation(body);
    cached = { source, representation };
    return representation;
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
  const headers = new Headers({
    ...(options.headers ?? {}),
    "Content-Type": options.contentType,
    "Cache-Control": options.cacheControl,
    ETag: representation.etag
  });
  if (notModified) {
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");
  } else {
    headers.set("Content-Length", String(representation.byteLength));
    if (representation.encoding) headers.set("Content-Encoding", representation.encoding);
  }
  return new Response(notModified ? null : representation.body, {
    status: notModified ? 304 : 200,
    headers
  });
}
