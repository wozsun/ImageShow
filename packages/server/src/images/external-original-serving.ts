import { createHash } from "node:crypto";
import { ApiError } from "../core/api-error.ts";
import {
  withPublicDatabaseRead,
  type PublicDatabaseReadAccess
} from "../core/public-db-fallback.ts";
import { coalesce } from "../core/coalesce.ts";
import { safeFetchExternalImage } from "../core/external-image-fetch.ts";
import {
  noStoreCacheControl,
  privateNoStoreCacheControl,
  publicProxyImageCacheControl,
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import { linkBaseUrl } from "../config/site-host.ts";
import {
  externalImageProxyTimeoutMs,
  externalImageProxyUserAgent,
  proxyExternalImage
} from "./external-image-proxy.ts";
import { readImageServingRecordById } from "./image-serving-record.ts";
import {
  displayUrlForOriginalComparison,
  hasDistinctOriginalUrl
} from "./original-link.ts";
import {
  getOriginalDirectCache,
  setOriginalDirectCache
} from "./original-direct-cache.ts";

export type ExternalOriginalServingDependencies = {
  readImageServingRecordById: typeof readImageServingRecordById;
  displayUrlForOriginalComparison: typeof displayUrlForOriginalComparison;
  supportsDirectAccess: typeof cachedOriginalSupportsDirectAccess;
  proxyExternalImage: typeof proxyExternalImage;
  linkBaseUrl: typeof linkBaseUrl;
};

function externalImageExt(url: string) {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (ext === "jpeg") return "jpg";
    return ext && ["jpg", "png", "webp", "gif", "avif"].includes(ext)
      ? ext
      : "jpg";
  } catch {
    return "jpg";
  }
}

async function originalSupportsDirectAccess(url: string, userAgent: string) {
  try {
    const response = await safeFetchExternalImage(url, {
      method: "GET",
      timeoutMs: externalImageProxyTimeoutMs,
      headers: {
        "User-Agent": userAgent || externalImageProxyUserAgent,
        Accept: "image/*,*/*",
        Range: "bytes=0-0"
      },
      imageValidation: "header"
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

function originalDirectUserAgentFamily(userAgent: string) {
  const ua = userAgent.toLowerCase();
  if (/(bot|crawler|spider|preview)/.test(ua)) return "bot";
  if (ua.includes("micromessenger")) return "wechat";
  if (ua.includes("firefox") || ua.includes("fxios")) return "firefox";
  if (ua.includes("edg/") || ua.includes("edgios") || ua.includes("edga")) {
    return "edge";
  }
  if (ua.includes("chrome") || ua.includes("crios") || ua.includes("chromium")) {
    return "chrome";
  }
  if (ua.includes("safari") && !ua.includes("android")) return "safari";
  return "other";
}

function originalDirectCacheKey(url: string, userAgent: string) {
  return createHash("sha1")
    .update(url)
    .update("\n")
    .update(originalDirectUserAgentFamily(userAgent))
    .digest("hex");
}

async function cachedOriginalSupportsDirectAccess(
  url: string,
  userAgent: string
) {
  const cacheKey = originalDirectCacheKey(
    url,
    userAgent || externalImageProxyUserAgent
  );
  const cached = await getOriginalDirectCache(cacheKey);
  if (cached) return cached.direct;

  return coalesce(`original-direct:${cacheKey}`, async () => {
    const raced = await getOriginalDirectCache(cacheKey);
    if (raced) return raced.direct;
    const direct = await originalSupportsDirectAccess(url, userAgent);
    await setOriginalDirectCache(cacheKey, direct);
    return direct;
  });
}

const defaultExternalOriginalServingDependencies:
  ExternalOriginalServingDependencies = {
    readImageServingRecordById,
    displayUrlForOriginalComparison,
    supportsDirectAccess: cachedOriginalSupportsDirectAccess,
    proxyExternalImage,
    linkBaseUrl
  };

async function resolveExternalOriginal(
  id: string,
  options: {
    includeDeleted?: boolean;
    database?: PublicDatabaseReadAccess;
  },
  dependencies: ExternalOriginalServingDependencies
) {
  const record = await dependencies.readImageServingRecordById(id, options);
  const original = record?.original ?? "";
  if (
    !record
    || (!options.includeDeleted && record.status !== "ready")
    || !/^https:\/\//i.test(original)
  ) {
    throw new ApiError(404, "not_found", "Original link not found");
  }
  const displayUrl = await dependencies.displayUrlForOriginalComparison(
    record,
    options.database
  );
  if (!hasDistinctOriginalUrl(original, displayUrl)) {
    throw new ApiError(404, "not_found", "Original link not found");
  }
  return { url: original, updatedAt: record.updated_at };
}

export async function redirectPublicExternalOriginal(
  id: string,
  userAgent: string,
  dependencies: ExternalOriginalServingDependencies =
    defaultExternalOriginalServingDependencies,
  signal: AbortSignal = new AbortController().signal
) {
  const original = await withPublicDatabaseRead(
    signal,
    (database) => resolveExternalOriginal(id, { database }, dependencies)
  );
  const direct = await dependencies.supportsDirectAccess(
    original.url,
    userAgent
  );
  return new Response(null, {
    status: 302,
    headers: {
      Location: safeResponseHeaderValue(
        "Location",
        direct
          ? original.url
          : `${dependencies.linkBaseUrl()}/original/${encodeURIComponent(id)}`
      ),
      "Cache-Control": privateNoStoreCacheControl,
      "Referrer-Policy": "no-referrer"
    }
  });
}

export async function servePublicExternalOriginal(
  id: string,
  request: {
    method?: "GET" | "HEAD";
    ifNoneMatch?: string;
    ifModifiedSince?: string;
    signal?: AbortSignal;
  } = {},
  dependencies: ExternalOriginalServingDependencies =
    defaultExternalOriginalServingDependencies
) {
  const signal = request.signal ?? new AbortController().signal;
  const original = await withPublicDatabaseRead(
    signal,
    (database) => resolveExternalOriginal(id, { database }, dependencies)
  );
  return dependencies.proxyExternalImage(
    original.url,
    externalImageExt(original.url),
    {
      method: request.method ?? "GET",
      validators: {
        ifNoneMatch: request.ifNoneMatch,
        ifModifiedSince: request.ifModifiedSince,
        resourceUpdatedAt: original.updatedAt
      }
    },
    {
      "Cache-Control": noStoreCacheControl,
      "Referrer-Policy": "no-referrer"
    },
    publicProxyImageCacheControl
  );
}

export async function serveAdminExternalOriginal(
  id: string,
  userAgent: string,
  dependencies: ExternalOriginalServingDependencies =
    defaultExternalOriginalServingDependencies
) {
  const original = await resolveExternalOriginal(
    id,
    { includeDeleted: true },
    dependencies
  );
  if (await dependencies.supportsDirectAccess(original.url, userAgent)) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: safeResponseHeaderValue("Location", original.url),
        "Cache-Control": privateNoStoreCacheControl,
        "Referrer-Policy": "no-referrer"
      }
    });
  }
  return dependencies.proxyExternalImage(
    original.url,
    externalImageExt(original.url),
    { method: "GET" },
    {
      "Cache-Control": privateNoStoreCacheControl,
      "Referrer-Policy": "no-referrer"
    }
  );
}
