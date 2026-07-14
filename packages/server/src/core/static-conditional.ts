import type { Context, Next } from "hono";

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
  return `W/\"${modifiedTime.toString(16)}-${resourceLength.toString(16)}-${encoding}\"`;
}

function noneMatchMatches(header: string, etag: string) {
  return header.split(",").some((candidate) => candidate.trim() === "*" || candidate.trim() === etag);
}

export async function conditionalStaticResponse(c: Context, next: Next) {
  await next();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return;
  if (c.res.status < 200 || c.res.status >= 300) return;

  const etag = staticEtag(c.res.headers);
  if (etag) c.header("ETag", etag);

  const ifNoneMatch = c.req.header("if-none-match");
  const lastModified = c.res.headers.get("Last-Modified");
  const ifModifiedSince = c.req.header("if-modified-since");
  const notModified = etag && ifNoneMatch
    ? noneMatchMatches(ifNoneMatch, etag)
    : Boolean(lastModified && ifModifiedSince && Date.parse(ifModifiedSince) >= Date.parse(lastModified));
  if (!notModified) return;

  const headers = new Headers(c.res.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  c.res = new Response(null, { status: 304, headers });
  c.res.headers.delete("Content-Length");
  c.res.headers.delete("Content-Encoding");
}
