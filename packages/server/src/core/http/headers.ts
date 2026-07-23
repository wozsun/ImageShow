import type { Context } from "hono";

export const cspReportPath = "/api/security/csp-report";
const cspReportGroup = "imageshow-csp";
const trustedTypePolicyNames = [
  "imageshow-altcha-worker",
  "svelte-trusted-html",
  "decodeHTMLEntitiesPolicy",
  "AGPolicy"
].join(" ");

export const securityHeaders: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
};

export const spaDocumentHeaders: Readonly<Record<string, string>> = {
  ...securityHeaders,
  "Content-Security-Policy": "script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "Content-Security-Policy-Report-Only": `require-trusted-types-for 'script'; trusted-types ${trustedTypePolicyNames}; report-to ${cspReportGroup}`,
  "Reporting-Endpoints": `${cspReportGroup}="${cspReportPath}"`
};

export const noStoreCacheControl = "no-store";
export const privateNoStoreCacheControl = "private, no-store";
export const immutableCacheControl = "public, max-age=31536000, immutable";
export const publicDocumentCacheControl = "public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=600";
export const publicDocsCacheControl = "public, max-age=0, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400";
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
