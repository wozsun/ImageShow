import { z } from "zod";
import { isIP } from "node:net";
import {
  publicImageOrders,
  homeBrowseTargets,
  importSourceTypes,
  logLevels,
  randomDefaultMethods,
  randomImageSizes,
  showDensities,
  runtimeConfigLimits,
  showModes,
  siteRoots
} from "@imageshow/shared/browser";
import { isRootRelativeOrHttpsUrl } from "../core/url-validation.ts";

const limits = runtimeConfigLimits;

function integerWithin({ min, max }: Readonly<{ min: number; max: number }>) {
  return z.coerce.number().int().min(min).max(max);
}

function decimalAbove({ min, max }: Readonly<{ min: number; max: number; exclusiveMin: true }>) {
  return z.coerce.number().gt(min).max(max);
}

export const siteRoot = z.enum(siteRoots);
export const homeBrowseTarget = z.enum(homeBrowseTargets);
export const randomDefaultMethod = z.enum(randomDefaultMethods);
export const randomImageSize = z.enum(randomImageSizes);
export const randomMaxItems = integerWithin(limits["site.random_max_items"]);
export const galleryOrder = z.enum(publicImageOrders);
export const showDensity = z.enum(showDensities);
export const showMode = z.enum(showModes);
export const showOrder = z.enum(publicImageOrders);
export const showDriftSpeed = integerWithin(limits["site.show.drift_speed"]);

export const siteHeaderName = z.string().trim().min(1);
export const siteTitle = z.string().trim().min(1);
export const siteDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(limits["site.domain"].maxLength)
  .refine((value) => {
    if (!value) return true;
    if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value)) return false;
    try {
      const parsed = new URL(`https://${value}`);
      const labels = parsed.hostname.split(".");
      const port = parsed.port ? Number(parsed.port) : 443;
      return (
        parsed.pathname === "/" &&
        !parsed.username &&
        !parsed.password &&
        isIP(parsed.hostname) === 0 &&
        labels.length >= 2 &&
        labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
        port >= 1 &&
        port <= 65_535
      );
    } catch {
      return false;
    }
  }, "站点域名需为空或不含协议和路径的有效 DNS 域名，可带端口");
export const siteAdditionalDomains = z
  .array(siteDomain.min(1, "附加站点域名不能为空"))
  .max(limits["site.additional_domains"].maxItems)
  .transform((values) => [...new Set(values)]);
export const siteIcon = z
  .string()
  .trim()
  .max(limits["site.icon"].maxLength)
  .refine(
    (value) => !value || isRootRelativeOrHttpsUrl(value),
    "站点图标必须是站内绝对路径或 HTTPS URL"
  );
export const siteDescription = z.string().trim().max(limits["site.description"].maxLength);
export const siteIcp = z.string().trim().max(limits["site.icp"].maxLength);
export const siteMps = z.string().trim().max(limits["site.mps"].maxLength);
export const siteFooter = z.string().trim().max(limits["site.footer"].maxLength);

export const loginBackground = z
  .string()
  .trim()
  .max(limits["admin.login_background"].maxLength)
  .refine(
    (value) => !value || isRootRelativeOrHttpsUrl(value),
    "登录背景必须是站内绝对路径或 HTTPS URL"
  );

export const homeBackground = z
  .string()
  .trim()
  .max(limits["site.home.background"].maxLength)
  .refine(
    (value) => !value || isRootRelativeOrHttpsUrl(value),
    "首页背景必须是站内绝对路径或 HTTPS URL"
  );
export const homeBannerLabel = z.string().trim().min(1).max(limits["site.home.banner_label"].maxLength);
export const homeBannerTitle = z.string().trim().min(1).max(limits["site.home.banner_title"].maxLength);

function isCspSafeHostname(hostname: string) {
  return (
    isIP(hostname) === 0 &&
    hostname.length <= 253 &&
    !hostname.endsWith(".") &&
    hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

const cspSourcePathPattern = /^(?:\/(?:[A-Za-z0-9\-._~!$&()+=:@]|%[0-9A-Fa-f]{2})*)+$/;

/**
 * An HTTPS origin, or a source for its subdomains with a single leftmost
 * wildcard. With `allowPath`, a path narrows it: one ending in "/" matches a
 * directory, any other exactly one file.
 */
function canonicalCspHostSource(value: string, allowPath: boolean) {
  const pattern = allowPath
    ? /^https:\/\/(?:\*\.)?[^\s*/?#\\@:]+(?::\d{1,5})?(?:\/[^\s*?#\\;,'"]*)?$/i
    : /^https:\/\/(?:\*\.)?[^\s*/?#\\@:]+(?::\d{1,5})?\/?$/i;
  if (!pattern.test(value)) return null;
  try {
    const parsed = new URL(value);
    const wildcard = /^https:\/\/\*\./i.test(value);
    const hostname = wildcard ? parsed.hostname.slice(2) : parsed.hostname;
    const validWildcard = wildcard
      ? parsed.hostname.startsWith("*.")
        && !hostname.includes("*")
        && hostname.includes(".")
      : !parsed.hostname.includes("*");
    // URL parsing resolves dot segments and percent-encodes the rest; the
    // result may hold only characters a CSP path part allows.
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (path && (!allowPath || !cspSourcePathPattern.test(path))) ||
      parsed.search ||
      parsed.hash ||
      !validWildcard ||
      (parsed.port !== "" && Number(parsed.port) < 1) ||
      !isCspSafeHostname(hostname)
    ) {
      return null;
    }
    return `https://${wildcard ? "*." : ""}${hostname}${parsed.port ? `:${parsed.port}` : ""}${path}`;
  } catch {
    return null;
  }
}

function cspHostSourceList(
  subject: string,
  allowPath: boolean,
  { maxItems, maxItemLength, maxSerializedLength }: (typeof limits)["site.script_sources"]
) {
  const source = z
    .string()
    .trim()
    .min(1)
    .max(maxItemLength)
    // Canonicalization can lengthen a value (percent-encoding, punycode), so
    // the limit also bounds what is stored: every accepted value parses again.
    .transform((value, context) => {
      const canonical = canonicalCspHostSource(value, allowPath);
      if (canonical === null) {
        context.addIssue({
          code: "custom",
          message: allowPath
            ? `${subject}必须是使用 DNS 主机名且不含参数或凭据的 HTTPS 地址，可使用最左侧单通配符的子域，可带目录或文件路径`
            : `${subject}必须是使用 DNS 主机名且不含路径、参数或凭据的 HTTPS origin，或使用最左侧单通配符的子域来源`
        });
        return z.NEVER;
      }
      if (canonical.length > maxItemLength) {
        context.addIssue({
          code: "custom",
          message: `${subject}规范化后（含百分号编码）不能超过 ${maxItemLength} 个字符`
        });
        return z.NEVER;
      }
      return canonical;
    });
  return z
    .array(source)
    .max(maxItems)
    .transform((values) => [...new Set(values)])
    .refine(
      (values) =>
        values.reduce((length, value) => length + value.length, 0) + Math.max(0, values.length - 1) <=
        maxSerializedLength,
      `${subject}列表过长`
    );
}

export const embedAllowedOrigins = cspHostSourceList("嵌入来源", false, limits["embed.allowed_origins"]);
// Scripts may be narrowed to one directory or file of a shared host.
export const siteScriptSources = cspHostSourceList("脚本来源", true, limits["site.script_sources"]);

export const ingestionMaxFileSizeMb = decimalAbove(limits["ingestion.max_file_size_mb"]);
export const ingestionMaxLongEdge = integerWithin(limits["ingestion.max_long_edge"]);
export const ingestionListPageSize = integerWithin(limits["ingestion.list_page_size"]);
export const uploadMaxItems = integerWithin(limits["upload.max_items"]);
export const imagePageSize = integerWithin(limits["admin.image_page_size"]);
export const recentUploads = integerWithin(limits["admin.recent_uploads"]);

export const uploadBrowserConcurrency = integerWithin(limits["upload.browser_concurrency"]);
export const uploadRawConcurrency = integerWithin(limits["upload.raw_concurrency"]);
export const ingestionCommitConcurrency = integerWithin(limits["ingestion.commit_concurrency"]);
export const importFetchTimeoutSeconds = integerWithin(limits["import.fetch_timeout_seconds"]);
export const importMaxItems = integerWithin(limits["import.max_items"]);
export const importTypesKeepingOriginalLink = z
  .array(z.enum(importSourceTypes))
  .transform((values) => [...new Set(values)]);
export const weiboImportMaxItems = integerWithin(limits["weibo.max_items"]);
export const weiboRequestDelaySeconds = z
  .number()
  .int()
  .min(limits["weibo.request_delay_seconds"].min)
  .max(limits["weibo.request_delay_seconds"].max);

export const sessionTtlSeconds = integerWithin(limits["security.session_ttl_seconds"]);
export const loginFailureWindowSeconds = integerWithin(limits["security.login_failure_window_seconds"]);
export const loginMaxFailures = integerWithin(limits["security.login_max_failures"]);
export const loginGlobalWindowSeconds = integerWithin(limits["security.login_global_window_seconds"]);
export const loginGlobalMaxAttempts = integerWithin(limits["security.login_global_max_attempts"]);
export const randomWindowSeconds = integerWithin(limits["security.random_window_seconds"]);
export const randomMaxRequests = integerWithin(limits["security.random_max_requests"]);
export const randomLimitMaxRequests = integerWithin(limits["security.random_limit_max_requests"]);

export const altchaTtlSeconds = integerWithin(limits["altcha.ttl_seconds"]);
export const altchaCost = integerWithin(limits["altcha.cost"]);
export const altchaCounter = z
  .number()
  .int()
  .min(limits["altcha.counter_range"].min)
  .max(limits["altcha.counter_range"].max);

export const logLevel = z.enum(logLevels);
export const logMaxSizeMb = decimalAbove(limits["log.max_size_mb"]);
export const logMaxFiles = integerWithin(limits["log.max_files"]);
