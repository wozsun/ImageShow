import { z } from "zod";
import { isIP } from "node:net";
import { appConfig } from "@imageshow/shared";
import {
  publicImageOrders,
  homeBrowseTargets,
  importSourceTypes,
  logLevels,
  randomDefaultMethods,
  randomImageSizes,
  showDensities,
  showModes,
  siteRoots
} from "@imageshow/shared/browser";
import { isRootRelativeOrHttpsUrl } from "../core/url-validation.ts";

export const siteRoot = z.enum(siteRoots);
export const homeBrowseTarget = z.enum(homeBrowseTargets);
export const randomDefaultMethod = z.enum(randomDefaultMethods);
export const randomImageSize = z.enum(randomImageSizes);
export const randomMaxItems = z.coerce.number().int().min(1).max(appConfig.randomQuery.maxJsonItems);
export const galleryOrder = z.enum(publicImageOrders);
export const showDensity = z.enum(showDensities);
export const showMode = z.enum(showModes);
export const showOrder = z.enum(publicImageOrders);
export const showDriftSpeed = z.coerce.number().int().min(10).max(60);

export const siteHeaderName = z.string().trim().min(1);
export const siteTitle = z.string().trim().min(1);
export const siteDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(259)
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
  .max(32)
  .transform((values) => [...new Set(values)]);
export const siteIcon = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => !value || isRootRelativeOrHttpsUrl(value),
    "站点图标必须是站内绝对路径或 HTTPS URL"
  );
export const siteDescription = z.string().trim().max(200);
export const siteFooterText = z.string().trim().max(200);
export const siteFooter = z.string().trim().max(2000);

export const loginBackground = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => !value || isRootRelativeOrHttpsUrl(value),
    "登录背景必须是站内绝对路径或 HTTPS URL"
  );

export const homeBackground = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => !value || isRootRelativeOrHttpsUrl(value),
    "首页背景必须是站内绝对路径或 HTTPS URL"
  );
export const homeBannerLabel = z.string().trim().min(1).max(160);
export const homeBannerTitle = z.string().trim().min(1).max(80);

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

function cspHostSourceList(subject: string, allowPath: boolean) {
  const maxItemLength = appConfig.cspHostSources.maxItemLength;
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
    .max(appConfig.cspHostSources.maxItems)
    .transform((values) => [...new Set(values)])
    .refine(
      (values) =>
        values.reduce((length, value) => length + value.length, 0) + Math.max(0, values.length - 1) <=
        appConfig.cspHostSources.maxSerializedLength,
      `${subject}列表过长`
    );
}

export const embedAllowedOrigins = cspHostSourceList("嵌入来源", false);
// Scripts may be narrowed to one directory or file of a shared host.
export const siteScriptSources = cspHostSourceList("脚本来源", true);

export const ingestionMaxFileSizeMb = z.coerce
  .number()
  .positive()
  .max(appConfig.ingestion.maxInputFileSizeMiB);
export const ingestionMaxLongEdge = z.coerce.number().int().min(300).max(32_000);
export const ingestionListPageSize = z.coerce.number().int().min(1).max(100);
export const uploadMaxItems = z.coerce
  .number()
  .int()
  .min(1)
  .max(appConfig.ingestion.uploadSoftLimitMax);
export const imagePageSize = z.coerce.number().int().min(10).max(appConfig.pagination.maxLimit);
export const recentUploads = z.coerce.number().int().min(1).max(60);

export const uploadBrowserConcurrency = z.coerce.number().int().min(1).max(8);
export const uploadRawConcurrency = z.coerce.number().int().min(1).max(8);
export const ingestionCommitConcurrency = z.coerce.number().int().min(1).max(16);
export const importFetchTimeoutSeconds = z.coerce.number().int().min(5).max(300);
export const importMaxItems = z.coerce
  .number()
  .int()
  .min(1)
  .max(appConfig.ingestion.importSoftLimitMax);
export const importTypesKeepingOriginalLink = z
  .array(z.enum(importSourceTypes))
  .transform((values) => [...new Set(values)]);
export const weiboImportMaxItems = z.coerce
  .number()
  .int()
  .min(1)
  .max(appConfig.ingestion.weiboSoftLimitMax);
export const weiboRequestDelaySeconds = z.number().int().min(0).max(60);

export const sessionTtlSeconds = z.coerce
  .number()
  .int()
  .min(5 * 60)
  .max(365 * 24 * 60 * 60);
export const loginFailureWindowSeconds = z.coerce.number().int().min(30).max(300);
export const loginMaxFailures = z.coerce.number().int().min(3).max(500);
export const loginGlobalWindowSeconds = z.coerce.number().int().min(60).max(600);
export const loginGlobalMaxAttempts = z.coerce.number().int().min(5).max(1_000);
export const randomWindowSeconds = z.coerce.number().int().min(1).max(3_600);
export const randomMaxRequests = z.coerce.number().int().min(1).max(10_000);


export const altchaTtlSeconds = z.coerce
  .number()
  .int()
  .min(
    Math.ceil(appConfig.authentication.altcha.solveTimeoutMs / 1000) +
      appConfig.authentication.altcha.challengeExpirySafetySeconds
  )
  .max(60 * 60);
export const altchaCost = z.coerce.number().int().min(1000).max(100_000);
export const altchaCounter = z.number().int().min(100).max(100_000);

export const logLevel = z.enum(logLevels);
export const logMaxSizeMb = z.coerce.number().positive().max(1024);
export const logMaxFiles = z.coerce.number().int().min(1).max(100);
