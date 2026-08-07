import type { Context } from "hono";

export const cspReportPath = "/api/security/csp-report";
const cspReportGroup = "imageshow-csp";
const trustedTypePolicyNames = [
  "imageshow-altcha-worker",
  "svelte-trusted-html",
  "decodeHTMLEntitiesPolicy",
  "AGPolicy"
].join(" ");

const commonSecurityHeaders: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()"
};

const securityHeaders: Readonly<Record<string, string>> = {
  ...commonSecurityHeaders,
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
};

const commonSpaDocumentHeaders: Readonly<Record<string, string>> = {
  ...commonSecurityHeaders,
  "Content-Security-Policy-Report-Only": [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "connect-src 'self'",
    "img-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "require-trusted-types-for 'script'",
    `trusted-types ${trustedTypePolicyNames}`,
    `report-uri ${cspReportPath}`,
    `report-to ${cspReportGroup}`
  ].join("; "),
  "Reporting-Endpoints": `${cspReportGroup}="${cspReportPath}"`
};

export const spaDocumentHeaders: Readonly<Record<string, string>> = {
  ...commonSpaDocumentHeaders,
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
};

const embedDocumentContextKey = "embedDocumentResponse";

export function embedSpaDocumentHeaders(
  allowedOrigins: readonly string[]
): Readonly<Record<string, string>> {
  const frameAncestors = allowedOrigins.length
    ? allowedOrigins.join(" ")
    : "'none'";
  return {
    ...commonSpaDocumentHeaders,
    "Content-Security-Policy": `script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors ${frameAncestors}`
  };
}

export function markEmbedDocumentResponse(context: Context, response: Response) {
  context.set(embedDocumentContextKey, true);
  return response;
}

export function finalizeSecurityHeaders(context: Context) {
  const embeddedDocument = context.get(embedDocumentContextKey) === true;
  if (embeddedDocument) context.res.headers.delete("X-Frame-Options");

  for (const [name, value] of Object.entries(securityHeaders)) {
    if (embeddedDocument && name === "X-Frame-Options") continue;
    if (!context.res.headers.has(name)) context.header(name, value);
  }
}

export const noStoreCacheControl = "no-store";
export const privateNoStoreCacheControl = "private, no-store";
export const privateRevalidationCacheControl = "private, no-cache";
export const immutableCacheControl = "public, max-age=31536000, immutable";
export const publicDocumentCacheControl = "public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=600";
export const publicStaticCacheControl = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800";
export const publicProxyImageCacheControl = "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, stale-if-error=2592000";
export const publicProxyFallbackThumbCacheControl = "public, max-age=604800, s-maxage=604800";
export const publicRedirectCacheControl = "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600, stale-if-error=86400";
const publicApiCacheControl = "public, max-age=0, s-maxage=30, stale-while-revalidate=30, stale-if-error=30";
export const publicListCacheControl = publicApiCacheControl;
export const publicMetadataCacheControl = publicApiCacheControl;
export const publicConfigCacheControl = publicApiCacheControl;
export const robotsCacheControl = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400";

export function appendVaryHeader(context: Context, ...names: string[]) {
  const existing = context.res.headers.get("Vary")
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean) ?? [];
  const normalized = new Map(existing.map((name) => [name.toLowerCase(), name]));
  for (const name of names) normalized.set(name.toLowerCase(), name);
  context.header("Vary", [...normalized.values()].join(", "));
}

const unsafeHeaderValuePattern =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

export function safeResponseHeaderValue(name: string, value: string) {
  if (unsafeHeaderValuePattern.test(value)) {
    throw new Error(`Unsafe ${name} response header value`);
  }
  // The Fetch implementation applies the remaining header-name and byte
  // syntax checks. Constructing a throwaway list keeps every dynamic value on
  // the same validation path before it reaches a response.
  new Headers({ [name]: value });
  return value;
}

export function responseContentLengthValue(value: unknown) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? String(value)
    : undefined;
}
