import { createHash } from "node:crypto";
import { ifNoneMatchCandidates } from "./validators.ts";

const proxyEtagPrefix = "imageshow-proxy";
const maxUpstreamEtagBytes = 512;

function originalUrlHash(originalUrl: string) {
  return createHash("sha256").update(originalUrl).digest("base64url");
}

function safeUpstreamEtag(value: string | null | undefined) {
  const candidate = value?.trim() ?? "";
  const candidates = ifNoneMatchCandidates(candidate);
  if (
    !candidate
    || Buffer.byteLength(candidate) > maxUpstreamEtagBytes
    || candidates.length !== 1
    || candidates[0] !== candidate
    || candidate === "*"
  ) {
    return undefined;
  }
  try {
    new Headers({ "If-None-Match": candidate });
    return candidate;
  } catch {
    return undefined;
  }
}

export function proxyEtagForUpstream(
  originalUrl: string,
  upstreamEtag: string | null | undefined
) {
  const safeEtag = safeUpstreamEtag(upstreamEtag);
  if (!safeEtag) return undefined;
  const encoded = Buffer.from(safeEtag).toString("base64url");
  return `W/"${proxyEtagPrefix}.${originalUrlHash(originalUrl)}.${encoded}"`;
}

function upstreamEtagFromProxy(originalUrl: string, proxyEtag: string) {
  const match = /^(?:W\/)?"imageshow-proxy\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]+)"$/u
    .exec(proxyEtag);
  if (!match || match[1] !== originalUrlHash(originalUrl)) return undefined;
  try {
    const decoded = Buffer.from(match[2]!, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== match[2]) return undefined;
    return safeUpstreamEtag(decoded);
  } catch {
    return undefined;
  }
}

export function upstreamIfNoneMatchForProxy(
  originalUrl: string,
  clientHeader: string | null | undefined
) {
  if (clientHeader == null) return undefined;
  const upstreamEtags = ifNoneMatchCandidates(clientHeader)
    .flatMap((candidate) => {
      if (candidate === "*") return [candidate];
      const upstream = upstreamEtagFromProxy(originalUrl, candidate);
      return upstream ? [upstream] : [];
    });
  return upstreamEtags.length ? [...new Set(upstreamEtags)].join(", ") : undefined;
}

function safeHttpDate(value: string | null | undefined, now: number) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now) return undefined;
  return Math.floor(timestamp / 1000) * 1000;
}

function safeResourceRevisionDate(value: string, now: number) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  // HTTP dates only retain whole seconds. Moving the local revision fence to
  // the following second prevents a validator emitted before an original-URL
  // change in the same second from validating the new URL. Until that fence
  // has passed, omit Last-Modified and do not forward date conditions.
  const revisionFence = Math.floor(timestamp / 1000) * 1000 + 1000;
  return revisionFence <= Math.floor(now / 1000) * 1000
    ? revisionFence
    : undefined;
}

export function proxyLastModified(
  upstreamValue: string | null | undefined,
  resourceUpdatedAt: string,
  now = Date.now()
) {
  const upstream = safeHttpDate(upstreamValue, now);
  return combinedProxyLastModified(upstream, resourceUpdatedAt, now);
}

export function proxyLastModifiedForUpstream304(
  upstreamValue: string | null | undefined,
  resourceUpdatedAt: string,
  now = Date.now()
) {
  const upstream = safeHttpDate(upstreamValue, now);
  if (upstream === undefined) return undefined;
  return combinedProxyLastModified(upstream, resourceUpdatedAt, now);
}

function combinedProxyLastModified(
  upstream: number | undefined,
  resourceUpdatedAt: string,
  now: number
) {
  const resource = safeResourceRevisionDate(resourceUpdatedAt, now);
  if (resource === undefined) return undefined;
  const timestamp = Math.max(
    upstream ?? Number.NEGATIVE_INFINITY,
    resource
  );
  return Number.isFinite(timestamp) ? new Date(timestamp).toUTCString() : undefined;
}

export function upstreamIfModifiedSinceForProxy(
  clientHeader: string | null | undefined,
  resourceUpdatedAt: string,
  now = Date.now()
) {
  const requested = safeHttpDate(clientHeader, now);
  const resource = safeResourceRevisionDate(resourceUpdatedAt, now);
  if (requested === undefined || resource === undefined || resource > requested) {
    return undefined;
  }
  return new Date(requested).toUTCString();
}
