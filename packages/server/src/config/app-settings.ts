import { z } from "zod";
import type {
  AdminSettings,
  SiteConfigDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import {
  ingestionCommitConcurrency,
  galleryLimit,
  galleryOrder,
  homeBackground,
  homeBannerLabel,
  homeBannerTitle,
  imagePageSize,
  ingestionListPageSize,
  loginBackground,
  normalizeMaxLongEdge,
  normalizeMaxSizeKb,
  normalizeConcurrency,
  normalizeMinQuality,
  normalizeQuality,
  randomDefaultMethod,
  recentUploads,
  siteRoot,
  siteName,
  skipWebpUnderKb,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadBrowserConcurrency
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
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== "object") return value !== undefined;
  return Object.values(value).some(hasDefinedSetting);
}

const appSettingsSchema = z.strictObject({
  site: z.strictObject({
    name: siteName.optional(),
    root: siteRoot.optional(),
    home: siteHomeConfigSchema.optional(),
    gallery: z.strictObject({
      limit: galleryLimit.optional(),
      order: galleryOrder.optional()
    }).optional(),
    random_method: randomDefaultMethod.optional()
  }).optional(),
  ingestion: z.strictObject({
    list_page_size: ingestionListPageSize.optional(),
    commit_concurrency: ingestionCommitConcurrency.optional()
  }).optional(),
  upload: z.strictObject({
    browser_concurrency: uploadBrowserConcurrency.optional()
  }).optional(),
  normalize: z.strictObject({
    concurrency: normalizeConcurrency.optional(),
    quality: normalizeQuality.optional(),
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

export function getIngestionMaxFileBytes() {
  return Math.floor(getRuntimeConfig().ingestion.max_file_size_mb * 1024 * 1024);
}

export function getIngestionMaxLongEdge() {
  return Math.floor(getRuntimeConfig().ingestion.max_long_edge);
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
    random_method
  } = settings.site;
  const {
    max_file_size_mb,
    max_long_edge,
    list_page_size,
    commit_concurrency
  } = settings.ingestion;
  const {
    max_items,
    browser_concurrency
  } = settings.upload;
  const {
    keep_original_link,
    auto_import,
    max_items: importMaxItemsValue
  } = settings.import;
  const weiboMaxItems = settings.weibo.max_items;
  const {
    concurrency,
    quality,
    min_quality,
    max_long_edge: normalizeMaxLongEdgeValue,
    max_size_kb,
    skip_webp_under_kb
  } = settings.normalize;
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
      gallery: {
        limit: gallery.limit,
        order: gallery.order
      },
      random_method
    },
    ingestion: {
      max_file_size_mb,
      max_long_edge,
      list_page_size,
      commit_concurrency
    },
    upload: {
      max_items,
      browser_concurrency
    },
    import: {
      keep_original_link,
      auto_import,
      max_items: importMaxItemsValue
    },
    weibo: { max_items: weiboMaxItems },
    normalize: {
      concurrency,
      quality,
      min_quality,
      max_long_edge: normalizeMaxLongEdgeValue,
      max_size_kb,
      skip_webp_under_kb
    },
    thumbnail: settings.thumbnail,
    admin: { login_background, image_page_size, recent_uploads, show_unset_theme_card }
  };
}

function effectiveLoginBackground(loginBackgroundValue?: string) {
  return loginBackgroundValue?.trim() || "/random?mode=redirect";
}

export function getEffectiveLoginBackground() {
  return effectiveLoginBackground(getRuntimeConfig().admin.login_background);
}

export function resolveIngestionSnapshotLimit(requestedLimit?: number) {
  return requestedLimit ?? getRuntimeConfig().ingestion.list_page_size;
}

export function siteConfigPayload(): SiteConfigDto {
  const runtime = getRuntimeConfig();
  const {
    name,
    description,
    icon,
    root,
    home,
    gallery
  } = runtime.site;
  return {
    site: {
      name,
      description,
      icon,
      root,
      home,
      gallery: {
        order: gallery.order,
        public_original_button: gallery.public_original_button
      },
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
  if (input.ingestion) runtimePatch.ingestion = input.ingestion;
  if (input.upload) runtimePatch.upload = input.upload;
  if (input.normalize) runtimePatch.normalize = input.normalize;
  if (input.thumbnail) runtimePatch.thumbnail = input.thumbnail;
  if (input.admin) runtimePatch.admin = input.admin;
  if (Object.keys(runtimePatch).length) await updateRuntimeConfig(runtimePatch);
}
