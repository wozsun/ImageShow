import type { Context, Next } from "hono";

function staticEtag(headers: Headers) {
  const modified = headers.get("Last-Modified");
  const length = headers.get("Content-Length");
  if (!modified || !length) return "";
  const encoding = headers.get("Content-Encoding") ?? "identity";
  return `W/\"${new Date(modified).getTime().toString(16)}-${Number(length).toString(16)}-${encoding}\"`;
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
