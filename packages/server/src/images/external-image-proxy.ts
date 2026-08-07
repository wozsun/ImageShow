import { ApiError } from "../core/api-error.ts";
import {
  isAllowedExternalImageContentType,
  isExternalImageRejection,
  safeFetchExternalImage
} from "../core/external-image-fetch.ts";
import {
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import {
  proxyEtagForUpstream,
  proxyLastModified,
  proxyLastModifiedForUpstream304,
  upstreamIfModifiedSinceForProxy,
  upstreamIfNoneMatchForProxy
} from "../core/http/proxy-validators.ts";
import { contentType } from "../storage/object-keys.ts";

export const externalImageProxyTimeoutMs = 12_000;
export const externalImageProxyUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type ProxyFallback = () => Response | Promise<Response>;

export type ExternalProxyRequest = {
  method: "GET" | "HEAD";
  validators?: {
    ifNoneMatch?: string;
    ifModifiedSince?: string;
    resourceUpdatedAt: string;
  };
};

function safeUpstreamResponseHeader(name: string, value: string | null) {
  if (!value) return "";
  try {
    return safeResponseHeaderValue(name, value);
  } catch {
    return "";
  }
}

export async function proxyExternalImage(
  externalUrl: string,
  ext: string,
  request: ExternalProxyRequest,
  baseHeaders: Record<string, string> = {},
  fallbackCacheControl?: string,
  fallback?: ProxyFallback
): Promise<Response> {
  const redirectFallback = async () => fallback ? fallback() : new Response(null, {
    status: 302,
    headers: {
      ...baseHeaders,
      Location: safeResponseHeaderValue("Location", externalUrl),
      "Referrer-Policy": "no-referrer"
    }
  });

  let origin: string;
  try {
    origin = `${new URL(externalUrl).origin}/`;
  } catch {
    if (fallback) return fallback();
    throw new ApiError(400, "external_image_rejected", "外部图片请求未通过安全校验");
  }

  try {
    const requestHeaders = new Headers({
      Referer: origin,
      "User-Agent": externalImageProxyUserAgent,
      Accept: "image/*,*/*"
    });
    let forwardedIfNoneMatch: string | undefined;
    let forwardedIfModifiedSince: string | undefined;
    if (request.validators) {
      if (request.validators.ifNoneMatch !== undefined) {
        forwardedIfNoneMatch = upstreamIfNoneMatchForProxy(
          externalUrl,
          request.validators.ifNoneMatch
        );
        if (forwardedIfNoneMatch) {
          requestHeaders.set("If-None-Match", forwardedIfNoneMatch);
        }
      } else {
        forwardedIfModifiedSince = upstreamIfModifiedSinceForProxy(
          request.validators.ifModifiedSince,
          request.validators.resourceUpdatedAt
        );
        if (forwardedIfModifiedSince) {
          requestHeaders.set("If-Modified-Since", forwardedIfModifiedSince);
        }
      }
    }

    // 外链代理带源站同源 Referer 绕过简单防盗链；HEAD 不读取字节，上游明确不支持
    // HEAD 或未提供可信图片类型时才以 GET 嗅探，并立即取消正文。
    const fetchUpstream = (method: "GET" | "HEAD") => safeFetchExternalImage(
      externalUrl,
      {
        method,
        timeoutMs: externalImageProxyTimeoutMs,
        headers: requestHeaders,
        imageValidation: method === "HEAD" ? "none" : "sniff"
      }
    );
    let upstream = await fetchUpstream(request.method);
    if (
      request.method === "HEAD"
      && (
        [405, 501].includes(upstream.status)
        || (
          upstream.ok
          && !isAllowedExternalImageContentType(
            upstream.headers.get("content-type")
          )
        )
      )
    ) {
      await upstream.body?.cancel().catch(() => undefined);
      upstream = await fetchUpstream("GET");
    }
    const conditionalForwarded = Boolean(
      forwardedIfNoneMatch || forwardedIfModifiedSince
    );
    if (upstream.status === 304 && request.validators && conditionalForwarded) {
      await upstream.body?.cancel().catch(() => undefined);
      const headers = proxyExternalResponseHeaders(
        externalUrl,
        upstream,
        baseHeaders,
        fallbackCacheControl,
        request.validators.resourceUpdatedAt,
        forwardedIfNoneMatch
      );
      return new Response(null, { status: 304, headers });
    }
    if (!upstream.ok || (request.method === "GET" && !upstream.body)) {
      await upstream.body?.cancel().catch(() => undefined);
      return redirectFallback();
    }

    const headers = proxyExternalResponseHeaders(
      externalUrl,
      upstream,
      baseHeaders,
      fallbackCacheControl,
      request.validators?.resourceUpdatedAt
    );
    headers.set(
      "Content-Type",
      safeUpstreamResponseHeader(
        "Content-Type",
        upstream.headers.get("content-type")
      ) || contentType(ext)
    );
    if (request.method === "HEAD") {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: upstream.status, headers });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    if (isExternalImageRejection(error)) {
      if (fallback) return fallback();
      throw error;
    }
    return redirectFallback();
  }
}

function proxyExternalResponseHeaders(
  externalUrl: string,
  upstream: Response,
  baseHeaders: Record<string, string>,
  fallbackCacheControl?: string,
  resourceUpdatedAt?: string,
  fallbackUpstreamEtag?: string
) {
  const headers = new Headers(baseHeaders);
  if (fallbackCacheControl) {
    // 代理图优先继承源站缓存策略；只有源站没有声明时才使用站内 CDN fallback。
    const originCacheControl = safeUpstreamResponseHeader(
      "Cache-Control",
      upstream.headers.get("cache-control")
    );
    const originExpires = safeUpstreamResponseHeader(
      "Expires",
      upstream.headers.get("expires")
    );
    if (originCacheControl) {
      headers.set("Cache-Control", originCacheControl);
      headers.delete("Expires");
    } else if (originExpires) {
      headers.delete("Cache-Control");
      headers.set("Expires", originExpires);
    } else if (upstream.status === 304) {
      // A 304 that omits cache metadata means “retain the stored response's
      // policy”. Do not replace it with either the base no-store value or the
      // normal 200 fallback policy.
      headers.delete("Cache-Control");
      headers.delete("Expires");
    } else {
      headers.set("Cache-Control", fallbackCacheControl);
      headers.delete("Expires");
    }
  }
  if (resourceUpdatedAt !== undefined) {
    const etag = proxyEtagForUpstream(
      externalUrl,
      upstream.headers.get("etag") ?? fallbackUpstreamEtag
    );
    if (etag) headers.set("ETag", etag);
    const upstreamLastModified = upstream.headers.get("last-modified");
    const lastModified = upstream.status === 304
      ? proxyLastModifiedForUpstream304(
        upstreamLastModified,
        resourceUpdatedAt
      )
      : proxyLastModified(upstreamLastModified, resourceUpdatedAt);
    if (lastModified) headers.set("Last-Modified", lastModified);
  }
  return headers;
}
