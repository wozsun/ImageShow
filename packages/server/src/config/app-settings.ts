import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import { ApiError } from "../core/http.ts";
import {
  galleryLimit,
  galleryOrder,
  homeHeroBackground,
  homeTagline,
  imagePageSize,
  importGlobalConcurrency,
  jsonlImportMaxItems,
  linkFetchTimeoutSeconds,
  linkImageConcurrency,
  linkImportMaxItems,
  listPageSize,
  loginBackground,
  maxFileSizeMb,
  maxLongEdge,
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

const siteHomeConfigSchema = z.object({
  enabled: z.boolean().default(appConfig.runtimeDefaults.site.home.enabled),
  tagline: homeTagline.default(appConfig.runtimeDefaults.site.home.tagline),
  hero_background: homeHeroBackground.default(appConfig.runtimeDefaults.site.home.hero_background),
  preview_delay_ms: previewDelayMs.default(appConfig.runtimeDefaults.site.home.preview_delay_ms)
});

const appSettingsSchema = z.object({
  site: z.object({
    name: siteName.optional(),
    domain: siteDomain.optional(),
    icon_url: siteIconUrl.optional(),
    root_redirect: rootRedirect.optional(),
    docs_enabled: z.boolean().optional(),
    home: siteHomeConfigSchema.optional(),
    gallery: z.object({
      default_limit: galleryLimit.default(appConfig.runtimeDefaults.site.gallery.default_limit),
      order: galleryOrder.default(appConfig.runtimeDefaults.site.gallery.order)
    }).optional(),
    random_default_method: randomMethod.optional()
  }).optional(),
  upload: z.object({
    max_file_size_mb: maxFileSizeMb.default(appConfig.runtimeDefaults.upload.max_file_size_mb),
    max_long_edge: maxLongEdge.default(appConfig.runtimeDefaults.upload.max_long_edge),
    list_page_size: listPageSize.default(appConfig.runtimeDefaults.upload.list_page_size),
    concurrency: uploadConcurrency.default(appConfig.runtimeDefaults.upload.concurrency),
    global_concurrency: importGlobalConcurrency.default(appConfig.runtimeDefaults.upload.global_concurrency)
  }).optional(),
  link_image: z.object({
    fill_original_url: z.boolean().default(appConfig.runtimeDefaults.link_image.fill_original_url),
    concurrency: linkImageConcurrency.default(appConfig.runtimeDefaults.link_image.concurrency),
    global_concurrency: importGlobalConcurrency.default(appConfig.runtimeDefaults.link_image.global_concurrency),
    fetch_timeout_seconds: linkFetchTimeoutSeconds.default(appConfig.runtimeDefaults.link_image.fetch_timeout_seconds),
    url_list_max_items: linkImportMaxItems.default(appConfig.runtimeDefaults.link_image.url_list_max_items),
    jsonl_max_items: jsonlImportMaxItems.default(appConfig.runtimeDefaults.link_image.jsonl_max_items)
  }).optional(),
  normalize: z.object({
    quality: normalizeQuality.default(appConfig.runtimeDefaults.normalize.quality),
    quality_step: normalizeQualityStep.default(appConfig.runtimeDefaults.normalize.quality_step),
    min_quality: normalizeMinQuality.default(appConfig.runtimeDefaults.normalize.min_quality),
    max_long_edge: normalizeMaxLongEdge.default(appConfig.runtimeDefaults.normalize.max_long_edge),
    max_size_kb: normalizeMaxSizeKb.default(appConfig.runtimeDefaults.normalize.max_size_kb),
    skip_webp_under_kb: skipWebpUnderKb.default(appConfig.runtimeDefaults.normalize.skip_webp_under_kb)
  }).optional(),
  thumbnail: z.object({
    long_edge: thumbnailLongEdge.default(appConfig.runtimeDefaults.thumbnail.long_edge),
    quality: thumbnailQuality.default(appConfig.runtimeDefaults.thumbnail.quality)
  }).optional(),
  image_detail: z.object({
    title_opens_image: z.boolean().default(appConfig.runtimeDefaults.image_detail.title_opens_image)
  }).optional(),
  admin: z.object({
    login_background: loginBackground.default(appConfig.runtimeDefaults.admin.login_background),
    image_page_size: imagePageSize.default(appConfig.runtimeDefaults.admin.image_page_size),
    recent_uploads: recentUploads.default(appConfig.runtimeDefaults.admin.recent_uploads),
    show_unset_theme_card: z.boolean().default(appConfig.runtimeDefaults.admin.show_unset_theme_card)
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

function getAppSettings() {
  const runtime = getRuntimeConfig();
  return {
    site: runtime.site,
    upload: runtime.upload,
    link_image: runtime.link_image,
    normalize: runtime.normalize,
    thumbnail: runtime.thumbnail,
    image_detail: runtime.image_detail,
    admin: runtime.admin,
    background_job: runtime.background_job
  };
}

export function reloadAppConfig() {
  reloadRuntimeConfig();
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

export function getSettingsForAdmin() {
  const settings = getAppSettings();
  const { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled } = settings.site;
  const { login_background, image_page_size, recent_uploads, show_unset_theme_card } = settings.admin;
  return {
    site: { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled },
    upload: settings.upload,
    normalize: settings.normalize,
    thumbnail: settings.thumbnail,
    image_detail: settings.image_detail,
    admin: { login_background, image_page_size, recent_uploads, show_unset_theme_card },
    link_image: settings.link_image
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
  const { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled } = runtime.site;
  return {
    site: {
      name,
      domain,
      icon_url,
      root_redirect,
      home: { ...home, hero_background: effectiveHomeHeroBackground(runtime.site) },
      gallery,
      random_default_method,
      docs_enabled
    },
    image_detail: runtime.image_detail
  };
}

export function saveAppSettings(input: AppSettingsInput) {
  const runtimePatch: Partial<RuntimeConfig> = {};
  if (input.site) runtimePatch.site = input.site as RuntimeConfig["site"];
  if (input.upload) runtimePatch.upload = input.upload as RuntimeConfig["upload"];
  if (input.link_image) runtimePatch.link_image = input.link_image as RuntimeConfig["link_image"];
  if (input.normalize) runtimePatch.normalize = input.normalize as RuntimeConfig["normalize"];
  if (input.thumbnail) runtimePatch.thumbnail = input.thumbnail as RuntimeConfig["thumbnail"];
  if (input.image_detail) runtimePatch.image_detail = input.image_detail;
  if (input.admin) runtimePatch.admin = input.admin as RuntimeConfig["admin"];
  if (Object.keys(runtimePatch).length) updateRuntimeConfig(runtimePatch);
}
