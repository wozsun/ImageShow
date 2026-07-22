import { z } from "zod";
import type { AdminSettings } from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import {
  galleryLimit,
  galleryOrder,
  homeHeroBackground,
  homeTagline,
  imagePageSize,
  linkImageConcurrency,
  listPageSize,
  loginBackground,
  normalizeMaxLongEdge,
  normalizeMaxSizeKb,
  normalizeMinQuality,
  normalizeQuality,
  normalizeQualityStep,
  previewDelayMs,
  randomMethod,
  recentUploads,
  rootRedirect,
  siteDomain,
  siteIconUrl,
  siteName,
  skipWebpUnderKb,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadConcurrency
} from "./fields.ts";
import {
  getRuntimeConfig,
  reloadRuntimeConfig,
  updateRuntimeConfig,
  type RuntimeConfig
} from "./runtime-config-store.ts";
import type { RuntimeConfigPatch } from "./runtime-config.ts";

const siteHomeConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  tagline: homeTagline.optional(),
  hero_background: homeHeroBackground.optional(),
  preview_delay_ms: previewDelayMs.optional()
});

const appSettingsSchema = z.strictObject({
  site: z.strictObject({
    name: siteName.optional(),
    domain: siteDomain.optional(),
    icon_url: siteIconUrl.optional(),
    root_redirect: rootRedirect.optional(),
    docs_enabled: z.boolean().optional(),
    home: siteHomeConfigSchema.optional(),
    gallery: z.strictObject({
      default_limit: galleryLimit.optional(),
      order: galleryOrder.optional()
    }).optional(),
    random_default_method: randomMethod.optional()
  }).optional(),
  upload: z.strictObject({
    list_page_size: listPageSize.optional(),
    concurrency: uploadConcurrency.optional()
  }).optional(),
  link_image: z.strictObject({
    fill_original_url: z.boolean().optional(),
    concurrency: linkImageConcurrency.optional()
  }).optional(),
  normalize: z.strictObject({
    quality: normalizeQuality.optional(),
    quality_step: normalizeQualityStep.optional(),
    min_quality: normalizeMinQuality.optional(),
    max_long_edge: normalizeMaxLongEdge.optional(),
    max_size_kb: normalizeMaxSizeKb.optional(),
    skip_webp_under_kb: skipWebpUnderKb.optional()
  }).optional(),
  thumbnail: z.strictObject({
    long_edge: thumbnailLongEdge.optional(),
    quality: thumbnailQuality.optional()
  }).optional(),
  image_detail: z.strictObject({
    title_opens_image: z.boolean().optional()
  }).optional(),
  admin: z.strictObject({
    login_background: loginBackground.optional(),
    image_page_size: imagePageSize.optional(),
    recent_uploads: recentUploads.optional(),
    show_unset_theme_card: z.boolean().optional()
  }).optional()
});

export type AppSettingsInput = z.infer<typeof appSettingsSchema>;

export function parseSettingsInput(value: unknown) {
  const result = appSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "validation_error", "Validation failed", result.error.flatten());
  }
  return result.data;
}

export async function reloadAppConfig() {
  await reloadRuntimeConfig();
}

export function getInputImageMaxBytes() {
  return Math.floor(getRuntimeConfig().upload.max_file_size_mb * 1024 * 1024);
}

export function getInputImageMaxLongEdge() {
  return Math.floor(getRuntimeConfig().upload.max_long_edge);
}

export function getThumbnailSettings() {
  return getRuntimeConfig().thumbnail;
}

export function getSettingsForAdmin(): AdminSettings {
  const settings = getRuntimeConfig();
  const { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled } = settings.site;
  const { max_items, max_file_size_mb, list_page_size, concurrency: uploadConcurrencyValue } = settings.upload;
  const {
    fill_original_url,
    concurrency: linkConcurrency,
    max_items: linkMaxItems
  } = settings.link_image;
  const { max_items: weiboMaxItems } = settings.weibo;
  const { commit_concurrency } = settings.import;
  const { login_background, image_page_size, recent_uploads, show_unset_theme_card } = settings.admin;
  return {
    site: { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled },
    upload: {
      max_items,
      max_file_size_mb,
      list_page_size,
      concurrency: uploadConcurrencyValue
    },
    link_image: {
      fill_original_url,
      concurrency: linkConcurrency,
      max_items: linkMaxItems
    },
    weibo: { max_items: weiboMaxItems },
    normalize: settings.normalize,
    thumbnail: settings.thumbnail,
    import: { commit_concurrency },
    image_detail: settings.image_detail,
    admin: { login_background, image_page_size, recent_uploads, show_unset_theme_card }
  };
}

function randomApiBackground(domain: string) {
  return `https://${domain}/random?m=redirect`;
}

function effectiveLoginBackground(loginBackgroundValue?: string) {
  return loginBackgroundValue?.trim() || "/random?m=redirect";
}

function effectiveHomeHeroBackground(site: RuntimeConfig["site"]) {
  return site.home.hero_background?.trim() || randomApiBackground(site.domain);
}

export function getEffectiveLoginBackground() {
  return effectiveLoginBackground(getRuntimeConfig().admin.login_background);
}

export function siteConfigPayload() {
  const runtime = getRuntimeConfig();
  const {
    name,
    domain,
    icon_url,
    version,
    root_redirect,
    home,
    gallery,
    random_default_method,
    docs_enabled
  } = runtime.site;
  return {
    site: {
      name,
      domain,
      icon_url,
      version,
      root_redirect,
      home: { ...home, hero_background: effectiveHomeHeroBackground(runtime.site) },
      gallery,
      random_default_method,
      docs_enabled
    },
    image_detail: runtime.image_detail
  };
}

export async function saveAppSettings(input: AppSettingsInput) {
  const runtimePatch: RuntimeConfigPatch = {};
  if (input.site) runtimePatch.site = input.site;
  if (input.upload) runtimePatch.upload = input.upload;
  if (input.link_image) runtimePatch.link_image = input.link_image;
  if (input.normalize) runtimePatch.normalize = input.normalize;
  if (input.thumbnail) runtimePatch.thumbnail = input.thumbnail;
  if (input.image_detail) runtimePatch.image_detail = input.image_detail;
  if (input.admin) runtimePatch.admin = input.admin;
  if (Object.keys(runtimePatch).length) await updateRuntimeConfig(runtimePatch);
}
