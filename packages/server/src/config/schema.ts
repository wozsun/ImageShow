// Shared zod field validators for the two places that describe user-settable config:
// the file-backed runtime schema (env.ts / config.json) and the admin settings API
// (settings.ts, an editable subset). Defining each field's bounds once keeps the two
// from drifting apart — change a limit here and both the bootstrap and the API agree.
// Each consumer applies its own .default()/.optional() on top.
import { z } from "zod";
import { appConfig } from "@imageshow/shared";

export const rootRedirect = z.enum(["home", "gallery"]);
export const randomMethod = z.enum(["proxy", "redirect"]);
export const galleryOrder = z.enum(["latest", "random"]);

export const siteName = z.string().trim().min(1);
export const siteDomain = z.string().trim().min(1);
export const siteIconUrl = z.string().trim().min(1);
// Login-page background image. Empty means "derive from the site's own random API"
// (see effectiveLoginBackground); a non-empty value is any image URL. Allows empty,
// unlike the fields above, so blank can mean "auto".
export const siteLoginBackground = z.string().trim().max(2048);
// Homepage hero background image. Same shape/semantics as the login background.
export const siteHomeHeroBackground = z.string().trim().max(2048);

export const previewDelayMs = z.coerce.number().int().min(0).max(30_000);
export const maxFileSizeMb = z.coerce.number().positive().max(200);
export const maxLongEdge = z.coerce.number().int().min(512).max(32_768);
export const listPageSize = z.coerce.number().int().min(5).max(100);
export const imagePageSize = z.coerce.number().int().min(10).max(appConfig.pagination.maxLimit);
export const galleryLimit = z.coerce.number().int().positive().max(appConfig.pagination.maxLimit);
export const recentUploads = z.coerce.number().int().min(1).max(50);
// One knob drives two parallelisms: how many files the browser uploads at once and how
// many thumb.generate tasks the worker runs at once (see Uploader / jobs.tasks).
export const uploadConcurrency = z.coerce.number().int().min(1).max(16);
// File-only worker concurrency for the idempotent move.cleanup task and the theme-reassign
// file moves (operation_log.*_concurrency).
export const taskConcurrency = z.coerce.number().int().min(1).max(32);

// Security / session tuning (file-only; see env.ts security.*). Defaults come from appConfig.
export const sessionTtlSeconds = z.coerce.number().int().min(5 * 60).max(365 * 24 * 60 * 60);
export const loginFailureWindowSeconds = z.coerce.number().int().min(60).max(24 * 60 * 60);
export const loginMaxFailures = z.coerce.number().int().min(1).max(1000);
export const loginGlobalWindowSeconds = z.coerce.number().int().min(10).max(60 * 60);
export const loginGlobalMaxAttempts = z.coerce.number().int().min(1).max(100_000);

// Thumbnail output tuning (file-only; see env.ts thumbnail.*). Affects only newly generated
// thumbnails — the long-edge cap (px) and webp quality (1–100).
export const thumbnailLongEdge = z.coerce.number().int().min(64).max(4096);
export const thumbnailQuality = z.coerce.number().int().min(1).max(100);

// Login captcha (file-only; see env.ts captcha.*). Code length and how long a challenge stays
// valid; the noise counts (distractor lines / speckle dots) tune the rendered image's
// difficulty — the rest of its look is a code-front constant (core/captcha.ts).
export const captchaCodeLength = z.coerce.number().int().min(3).max(8);
export const captchaTtlSeconds = z.coerce.number().int().min(30).max(60 * 60);
export const captchaNoiseLines = z.coerce.number().int().min(0).max(60);
export const captchaNoiseDots = z.coerce.number().int().min(0).max(400);

// File-only logging (see env.ts log.*). Threshold level plus size-based rotation of the app log.
export const logLevel = z.enum(["DEBUG", "INFO", "WARN", "ERROR", "OFF"]);
export const logMaxSizeMb = z.coerce.number().positive().max(1024);
export const logMaxFiles = z.coerce.number().int().min(1).max(100);
