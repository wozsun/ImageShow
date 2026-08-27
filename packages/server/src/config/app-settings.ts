import { z } from "zod";
import type {
  AdminSettings,
  SiteConfigDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import {
  galleryLimit,
  galleryOrder,
  homeBackground,
  homeBannerLabel,
  homeBannerTitle,
  imagePageSize,
  importConcurrency,
  listPageSize,
  loginBackground,
  normalizeMaxLongEdge,
  normalizeMaxSizeKb,
  normalizeMinQuality,
  normalizeQuality,
  normalizeQualityStep,
  randomDefaultMethod,
  recentUploads,
  siteRoot,
  siteName,
  skipWebpUnderKb,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadConcurrency
} from "./fields.ts";
import {
  getRuntimeConfig,
  updateRuntimeConfig
} from "./runtime-config-store.ts";
import { effectiveEmbedAncestorSources } from "./embed-ancestors.ts";
import { staticLocalBaseUrl } from "./site-host.ts";
import type { RuntimeConfigPatch } from "./runtime-config.ts";

const siteHomeConfigSchema = z.strictObject({
  background: homeBackground.optional(),
  banner_label: homeBannerLabel.optional(),
  banner_title: homeBannerTitle.optional()
});

function hasDefinedSetting(value: unknown): boolean {
  if (!value || typeof value !== "object") return value !== undefined;
  return Object.values(value).some(hasDefinedSetting);
}

const appSettingsSchema = z.strictObject({
  site: z.strictObject({
    name: siteName.optional(),
    root: siteRoot.optional(),
    home: siteHomeConfigSchema.optional(),
    gallery: z.strictObject({
      default_limit: galleryLimit.optional(),
      order: galleryOrder.optional()
    }).optional(),
    random_default_method: randomDefaultMethod.optional()
  }).optional(),
  upload: z.strictObject({
    list_page_size: listPageSize.optional(),
    concurrency: uploadConcurrency.optional()
  }).optional(),
  import: z.strictObject({
    fill_original_url: z.boolean().optional(),
    auto_import: z.boolean().optional(),
    concurrency: importConcurrency.optional()
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
  admin: z.strictObject({
    login_background: loginBackground.optional(),
    image_page_size: imagePageSize.optional(),
    recent_uploads: recentUploads.optional(),
    show_unset_theme_card: z.boolean().optional()
  }).optional()
}).refine(
  hasDefinedSetting,
  "至少需要提供一项设置"
);

export type AppSettingsInput = z.infer<typeof appSettingsSchema>;

export function parseSettingsInput(value: unknown) {
  const result = appSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "validation_error", "Validation failed", result.error.flatten());
  }
  return result.data;
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
  const {
    name,
    root,
    home,
    gallery,
    random_default_method
  } = settings.site;
  const { commit_concurrency } = settings.ingestion;
  const {
    max_items,
    max_file_size_mb,
    max_long_edge,
    list_page_size,
    concurrency: uploadConcurrencyValue
  } = settings.upload;
  const {
    fill_original_url,
    auto_import,
    concurrency: importConcurrencyValue,
    max_items: importMaxItemsValue
  } = settings.import;
  const { max_items: weiboMaxItems } = settings.weibo;
  const { login_background, image_page_size, recent_uploads, show_unset_theme_card } = settings.admin;
  return {
    site: {
      name,
      root,
      home: {
        background: home.background,
        banner_label: home.banner_label,
        banner_title: home.banner_title
      },
      gallery,
      random_default_method
    },
    ingestion: { commit_concurrency },
    upload: {
      max_items,
      max_file_size_mb,
      max_long_edge,
      list_page_size,
      concurrency: uploadConcurrencyValue
    },
    import: {
      fill_original_url,
      auto_import,
      concurrency: importConcurrencyValue,
      max_items: importMaxItemsValue
    },
    weibo: { max_items: weiboMaxItems },
    normalize: settings.normalize,
    thumbnail: settings.thumbnail,
    admin: { login_background, image_page_size, recent_uploads, show_unset_theme_card }
  };
}

function effectiveLoginBackground(loginBackgroundValue?: string) {
  return loginBackgroundValue?.trim() || "/random?m=redirect";
}

export function getEffectiveLoginBackground() {
  return effectiveLoginBackground(getRuntimeConfig().admin.login_background);
}

export function siteConfigPayload(): SiteConfigDto {
  const runtime = getRuntimeConfig();
  const {
    name,
    description,
    icon_url,
    root,
    home,
    gallery
  } = runtime.site;
  return {
    site: {
      name,
      description,
      icon_url,
      root,
      home,
      gallery: { order: gallery.order },
      static_url: staticLocalBaseUrl()
    },
    embed: {
      enabled: effectiveEmbedAncestorSources(runtime).length > 0
    }
  };
}

export async function saveAppSettings(input: AppSettingsInput) {
  const runtimePatch: RuntimeConfigPatch = {};
  if (input.site) runtimePatch.site = input.site;
  if (input.upload) runtimePatch.upload = input.upload;
  if (input.import) runtimePatch.import = input.import;
  if (input.normalize) runtimePatch.normalize = input.normalize;
  if (input.thumbnail) runtimePatch.thumbnail = input.thumbnail;
  if (input.admin) runtimePatch.admin = input.admin;
  if (Object.keys(runtimePatch).length) await updateRuntimeConfig(runtimePatch);
}
