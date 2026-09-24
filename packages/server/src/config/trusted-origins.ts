import type { RuntimeConfig } from "@imageshow/shared/browser";
import { hasExplicitSiteDomain } from "../core/url-validation.ts";
import { getRuntimeConfig } from "./runtime-config-store.ts";

type TrustedOriginConfig = Pick<RuntimeConfig, "site" | "embed">;

export function trustedOriginSources(config: TrustedOriginConfig = getRuntimeConfig()) {
  if (!hasExplicitSiteDomain(config.site.domain)) {
    return ["'self'", ...config.embed.allowed_origins];
  }
  const siteUrl = new URL(`https://${config.site.domain}`);
  const authority = `${siteUrl.hostname}${siteUrl.port ? `:${siteUrl.port}` : ""}`;
  return [
    ...new Set([`https://${authority}`, `https://*.${authority}`, ...config.embed.allowed_origins])
  ];
}

export function isTrustedReferer(
  value: string | undefined,
  selfOrigin: string,
  config: TrustedOriginConfig = getRuntimeConfig()
) {
  if (!value || /[\\\u0000-\u0020\u007f]/u.test(value)) return false;
  let referer: URL;
  try {
    referer = new URL(value);
  } catch {
    return false;
  }
  if (
    !["http:", "https:"].includes(referer.protocol) ||
    referer.username ||
    referer.password ||
    referer.hash
  )
    return false;

  return trustedOriginSources(config).some((source) => {
    if (source === "'self'") return referer.origin === selfOrigin;
    const allowed = new URL(source);
    if (referer.protocol !== allowed.protocol || referer.port !== allowed.port) return false;
    return allowed.hostname.startsWith("*.")
      ? referer.hostname.endsWith(allowed.hostname.slice(1))
      : referer.hostname === allowed.hostname;
  });
}
