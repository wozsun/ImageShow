import { isIP } from "node:net";
import { z } from "zod";

export const publicBaseUrlSchema = z.string().trim().max(2048).transform((value, ctx) => {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || /[\\?#\s]/u.test(value)
      || !matchesSiteHost(url.host, "")) throw new Error("Invalid public URL");
    const segments = url.pathname.split("/").filter(Boolean).map((part) => {
      const decoded = decodeURIComponent(part);
      if (decoded === "." || decoded === ".." || /[/\\\u0000-\u0020\u007f]/u.test(decoded)) {
        throw new Error("Invalid public URL path");
      }
      return encodeURIComponent(decoded);
    });
    return `${url.origin}${segments.length ? `/${segments.join("/")}` : ""}`;
  } catch {
    ctx.addIssue({ code: "custom", message: "公开地址须为合法 HTTPS 根地址，可包含路径前缀，不能包含凭据、查询参数或片段" });
    return z.NEVER;
  }
});

export function publicUrlMatchesHost(base: URL, host: string) {
  const authority = host.trim().toLowerCase();
  return authority === base.host || (!base.port && authority === `${base.hostname}:443`);
}

export function publicUrlUsesSiteHost(publicBaseUrl: string, siteDomain: string) {
  if (!publicBaseUrl || !hasExplicitSiteDomain(siteDomain)) return false;
  const url = new URL(publicBaseUrl);
  return matchesSiteHost(url.host, siteDomain)
    || (!url.port && matchesSiteHost(`${url.hostname}:443`, siteDomain));
}

type HttpsUrlOptions = {
  requireDomain?: boolean;
};

export function isHttpsUrl(value: string, options: HttpsUrlOptions = {}) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      return false;
    }
    return !options.requireDomain || isIP(parsed.hostname.replace(/^\[|\]$/g, "")) === 0;
  } catch {
    return false;
  }
}

export function isRootRelativeOrHttpsUrl(value: string) {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return !/[\\\u0000-\u001f\u007f]/.test(value);
  }
  return isHttpsUrl(value);
}

export function isHttpsEndpoint(value: string) {
  if (!value) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return isHttpsUrl(value);
  return isHttpsUrl(`https://${value}`);
}

type HostParts = { hostname: string; port: string };

export function hasExplicitSiteDomain(domain: string) {
  return domain !== "" && domain !== "example.com";
}

export function matchesSiteHost(hostHeader: string, domain: string) {
  const raw = hostHeader.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(raw)) return false;
  const current = splitHost(raw);
  if (!current.hostname) return false;
  if (current.port && (Number(current.port) < 1 || Number(current.port) > 65_535)) return false;
  if (!hasExplicitSiteDomain(domain)) return true;
  const root = splitHost(domain);
  return current.hostname === root.hostname && (!root.port || current.port === root.port);
}

function splitHost(value: string): HostParts {
  const raw = value.trim().toLowerCase();
  if (!raw) return { hostname: "", port: "" };
  const portMatch = /:(\d+)$/.exec(raw);
  const port = portMatch?.[1] ?? "";
  const hostname = port ? raw.slice(0, -port.length - 1) : raw;
  return { hostname, port };
}
