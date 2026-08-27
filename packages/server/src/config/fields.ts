import { z } from "zod";
import { isIP } from "node:net";
import { appConfig } from "@imageshow/shared";
import {
  galleryOrders,
  logLevels,
  randomDefaultMethods,
  siteRoots
} from "@imageshow/shared/browser";
import { isRootRelativeOrHttpsUrl } from "../core/url-validation.ts";

export const siteRoot = z.enum(siteRoots);
export const randomDefaultMethod = z.enum(randomDefaultMethods);
export const galleryOrder = z.enum(galleryOrders);

export const siteName = z.string().trim().min(1);
export const siteDomain = z.string().trim().toLowerCase().min(1).max(259).refine((value) => {
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value)) return false;
  try {
    const parsed = new URL(`https://${value}`);
    const labels = parsed.hostname.split(".");
    const port = parsed.port ? Number(parsed.port) : 443;
    return parsed.pathname === "/" &&
      !parsed.username &&
      !parsed.password &&
      isIP(parsed.hostname) === 0 &&
      labels.length >= 2 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
      port >= 1 && port <= 65_535;
  } catch {
    return false;
  }
}, "站点域名需为不含协议和路径的有效 DNS 域名，可带端口");
export const siteIconUrl = z.string().trim().min(1).max(2048)
  .refine(isRootRelativeOrHttpsUrl, "站点图标必须是站内绝对路径或 HTTPS URL");
export const siteDescription = z.string().trim().max(200);

export const loginBackground = z.string().trim().max(2048)
  .refine((value) => !value || isRootRelativeOrHttpsUrl(value), "登录背景必须是站内绝对路径或 HTTPS URL");

export const homeBackground = z.string().trim().max(2048)
  .refine((value) => !value || isRootRelativeOrHttpsUrl(value), "首页背景必须是站内绝对路径或 HTTPS URL");
export const homeBannerLabel = z.string().trim().min(1).max(160);
export const homeBannerTitle = z.string().trim().min(1).max(80);

function isCspSafeEmbedHostname(hostname: string) {
  return isIP(hostname) === 0
    && hostname.length <= 253
    && !hostname.endsWith(".")
    && hostname.split(".").every(
      (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    );
}

function canonicalEmbedAncestorSource(value: string) {
  if (!/^https:\/\/(?:\*\.)?[^\s*/?#\\@:]+(?::\d{1,5})?\/?$/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    const wildcard = /^https:\/\/\*\./i.test(value);
    const hostname = wildcard ? parsed.hostname.slice(2) : parsed.hostname;
    const validWildcard = wildcard
      ? parsed.hostname.startsWith("*.")
        && !hostname.includes("*")
        && hostname.includes(".")
      : !parsed.hostname.includes("*");
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || !validWildcard
      || (parsed.port !== "" && Number(parsed.port) < 1)
      || !isCspSafeEmbedHostname(hostname)
    ) {
      return null;
    }
    return `https://${wildcard ? "*." : ""}${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

const embedAllowedOrigin = z.string().trim().min(1)
  .max(appConfig.embedding.maxOriginLength)
  .refine(
    (value) => canonicalEmbedAncestorSource(value) !== null,
    "嵌入来源必须是使用 DNS 主机名且不含路径、参数或凭据的 HTTPS origin，或使用最左侧单通配符的子域来源"
  )
  .transform((value) => canonicalEmbedAncestorSource(value)!);

export const embedAllowedOrigins = z.array(embedAllowedOrigin)
  .max(appConfig.embedding.maxAllowedOrigins)
  .transform((values) => [...new Set(values)])
  .refine(
    (values) => values.reduce((length, value) => length + value.length, 0)
      + Math.max(0, values.length - 1)
      <= appConfig.embedding.maxSerializedOriginsLength,
    "嵌入来源列表过长"
  );

export const maxFileSizeMb = z.coerce.number().positive()
  .max(appConfig.ingestion.maxInputFileSizeMiB);
export const maxLongEdge = z.coerce.number().int().min(300).max(32_000);
export const listPageSize = z.coerce.number().int().min(1).max(100);
export const uploadMaxItems = z.coerce.number().int().min(1)
  .max(appConfig.ingestion.uploadSoftLimitMax);
export const imagePageSize = z.coerce.number().int().min(10).max(appConfig.pagination.maxLimit);
export const galleryLimit = z.coerce.number().int().positive().max(appConfig.pagination.maxLimit);
export const recentUploads = z.coerce.number().int().min(1).max(50);

export const uploadConcurrency = z.coerce.number().int().min(1).max(128);
export const ingestionStageConcurrency = z.coerce.number().int().min(1).max(512);
export const commitConcurrency = z.coerce.number().int().min(1).max(128);
export const globalCommitConcurrency = z.coerce.number().int().min(1).max(512);
export const globalCommitByteBudgetMb = z.coerce.number().int().min(16).max(4096);

export const normalizeQuality = z.coerce.number().int().min(1).max(100);
export const normalizeQualityStep = z.coerce.number().int().min(1).max(50);
export const normalizeMinQuality = z.coerce.number().int().min(1).max(100);
export const normalizeMaxLongEdge = z.coerce.number().int().min(512).max(32_768);
export const normalizeMaxSizeKb = z.coerce.number().int().min(50).max(100 * 1024);
export const skipWebpUnderKb = z.coerce.number().int().min(0).max(100 * 1024);
export const importConcurrency = z.coerce.number().int().min(1).max(128);
export const importFetchTimeoutSeconds = z.coerce.number().int().min(5).max(300);
export const importMaxItems = z.coerce.number().int().min(1)
  .max(appConfig.ingestion.importSoftLimitMax);
export const weiboImportMaxItems = z.coerce.number().int().min(1)
  .max(appConfig.ingestion.weiboSoftLimitMax);
export const weiboMetadataConcurrency = z.coerce.number().int().min(1).max(16);
export const weiboGlobalConcurrency = z.coerce.number().int().min(1).max(32);

export const taskConcurrency = z.coerce.number().int().min(1).max(512);

export const sessionTtlSeconds = z.coerce.number().int().min(5 * 60).max(365 * 24 * 60 * 60);
export const loginFailureWindowSeconds = z.coerce.number().int().min(30).max(300);
export const loginMaxFailures = z.coerce.number().int().min(3).max(500);
export const loginGlobalWindowSeconds = z.coerce.number().int().min(60).max(600);
export const loginGlobalMaxAttempts = z.coerce.number().int().min(5).max(1_000);

export const thumbnailLongEdge = z.coerce.number().int().min(64).max(4096);
export const thumbnailQuality = z.coerce.number().int().min(1).max(100);

export const altchaTtlSeconds = z.coerce.number().int()
  .min(
    Math.ceil(appConfig.authentication.altcha.solveTimeoutMs / 1000) +
    appConfig.authentication.altcha.challengeExpirySafetySeconds
  )
  .max(60 * 60);
export const altchaCost = z.coerce.number().int().min(1000).max(100_000);
export const altchaCounter = z.coerce.number().int().min(100).max(100_000);

export const logLevel = z.enum(logLevels);
export const logMaxSizeMb = z.coerce.number().positive().max(1024);
export const logMaxFiles = z.coerce.number().int().min(1).max(100);
