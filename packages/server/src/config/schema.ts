import { z } from "zod";
import { appConfig } from "@imageshow/shared";

export const rootRedirect = z.enum(["home", "gallery"]);
export const randomMethod = z.enum(["proxy", "redirect"]);
export const galleryOrder = z.enum(["latest", "random"]);

export const siteName = z.string().trim().min(1);
export const siteDomain = z.string().trim().min(1);
export const siteIconUrl = z.string().trim().min(1);

export const loginBackground = z.string().trim().max(2048);

export const homeHeroBackground = z.string().trim().max(2048);
export const homeTagline = z.string().trim().max(200);

export const previewDelayMs = z.coerce.number().int().min(0).max(30_000);
export const maxFileSizeMb = z.coerce.number().positive().max(200);
export const maxLongEdge = z.coerce.number().int().min(512).max(32_768);
export const listPageSize = z.coerce.number().int().min(5).max(100);
export const imagePageSize = z.coerce.number().int().min(10).max(appConfig.pagination.maxLimit);
export const galleryLimit = z.coerce.number().int().positive().max(appConfig.pagination.maxLimit);
export const recentUploads = z.coerce.number().int().min(1).max(50);

export const uploadConcurrency = z.coerce.number().int().min(1).max(16);

export const normalizeQuality = z.coerce.number().int().min(1).max(100);
export const normalizeQualityStep = z.coerce.number().int().min(1).max(50);
export const normalizeMinQuality = z.coerce.number().int().min(1).max(100);
export const normalizeMaxLongEdge = z.coerce.number().int().min(512).max(32_768);
export const normalizeMaxSizeKb = z.coerce.number().int().min(50).max(100 * 1024);
export const skipWebpUnderKb = z.coerce.number().int().min(0).max(100 * 1024);
export const linkImageConcurrency = z.coerce.number().int().min(1).max(16);

export const taskConcurrency = z.coerce.number().int().min(1).max(32);

export const sessionTtlSeconds = z.coerce.number().int().min(5 * 60).max(365 * 24 * 60 * 60);
export const loginFailureWindowSeconds = z.coerce.number().int().min(60).max(24 * 60 * 60);
export const loginMaxFailures = z.coerce.number().int().min(1).max(1000);
export const loginGlobalWindowSeconds = z.coerce.number().int().min(10).max(60 * 60);
export const loginGlobalMaxAttempts = z.coerce.number().int().min(1).max(100_000);

export const thumbnailLongEdge = z.coerce.number().int().min(64).max(4096);
export const thumbnailQuality = z.coerce.number().int().min(1).max(100);

export const captchaCodeLength = z.coerce.number().int().min(3).max(8);
export const captchaTtlSeconds = z.coerce.number().int().min(30).max(60 * 60);
export const captchaNoiseLines = z.coerce.number().int().min(0).max(60);
export const captchaNoiseDots = z.coerce.number().int().min(0).max(400);

export const logLevel = z.enum(["DEBUG", "INFO", "WARN", "ERROR", "OFF"]);
export const logMaxSizeMb = z.coerce.number().positive().max(1024);
export const logMaxFiles = z.coerce.number().int().min(1).max(100);
