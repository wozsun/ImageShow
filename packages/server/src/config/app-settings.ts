import { z } from "zod";
import type {
  AdminSettings,
  RuntimeConfig,
  SiteConfigDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import {
  ingestionCommitConcurrency,
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
  randomImageSize,
  recentUploads,
  siteRoot,
  siteHeaderName,
  siteTitle,
  skipWebpUnderKb,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadBrowserConcurrency
} from "./field-schemas.ts";
import {
  getRuntimeConfig,
  updateRuntimeConfig
} from "./runtime-config-store.ts";
import { effectiveEmbedAncestorSources } from "./embed-ancestors.ts";
import { publicBaseUrlSchema } from "../core/url-validation.ts";
import { staticResourceBaseUrl } from "./site-host.ts";

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

const appSettingsSchema = z
  .strictObject({
    site: z
      .strictObject({
        title: siteTitle.optional(),
        header_name: siteHeaderName.optional(),
        root: siteRoot.optional(),
        home: siteHomeConfigSchema.optional(),
        gallery: z
          .strictObject({
            order: galleryOrder.optional()
          })
          .optional(),
        random_method: randomDefaultMethod.optional(),
        random_size: randomImageSize.optional(),
        assets_base_url: publicBaseUrlSchema.optional()
      })
      .optional(),
    ingestion: z
      .strictObject({
        list_page_size: ingestionListPageSize.optional(),
        commit_concurrency: ingestionCommitConcurrency.optional()
      })
      .optional(),
    upload: z
      .strictObject({
        browser_concurrency: uploadBrowserConcurrency.optional()
      })
      .optional(),
    normalize: z
      .strictObject({
        concurrency: normalizeConcurrency.optional(),
        quality: normalizeQuality.optional(),
        min_quality: normalizeMinQuality.optional(),
        max_long_edge: normalizeMaxLongEdge.optional(),
        max_size_kb: normalizeMaxSizeKb.optional(),
        skip_webp_under_kb: skipWebpUnderKb.optional()
      })
      .optional(),
    thumbnail: z
      .strictObject({
        long_edge: thumbnailLongEdge.optional(),
        quality: thumbnailQuality.optional()
      })
      .optional(),
    admin: z
      .strictObject({
        login_background: loginBackground.optional(),
        image_page_size: imagePageSize.optional(),
        recent_uploads: recentUploads.optional()
      })
      .optional()
  })
  .refine(hasDefinedSetting, "至少需要提供一项设置");

type AppSettingsInput = z.infer<typeof appSettingsSchema>;

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

export function getSettingsForAdmin(settings: RuntimeConfig = getRuntimeConfig()): AdminSettings {
  const { title, header_name, root, home, gallery, random_method, random_size, assets_base_url } =
    settings.site;
  const { max_file_size_mb, max_long_edge, list_page_size, commit_concurrency } =
    settings.ingestion;
  const { max_items, browser_concurrency } = settings.upload;
  const { keep_original_link, auto_import, max_items: importMaxItemsValue } = settings.import;
  const weiboMaxItems = settings.weibo.max_items;
  const {
    concurrency,
    quality,
    min_quality,
    max_long_edge: normalizeMaxLongEdgeValue,
    max_size_kb,
    skip_webp_under_kb
  } = settings.normalize;
  const { login_background, image_page_size, recent_uploads } = settings.admin;
  return {
    site: {
      title,
      header_name,
      root,
      home: {
        background: home.background,
        banner_label: home.banner_label,
        banner_title: home.banner_title
      },
      gallery: {
        order: gallery.order
      },
      random_method,
      random_size,
      assets_base_url
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
    admin: { login_background, image_page_size, recent_uploads }
  };
}

function effectiveBackground(value: string) {
  return value.trim() || "/random?mode=redirect";
}

export function getEffectiveLoginBackground() {
  return effectiveBackground(getRuntimeConfig().admin.login_background);
}

export function resolveIngestionSnapshotLimit(requestedLimit?: number) {
  return requestedLimit ?? getRuntimeConfig().ingestion.list_page_size;
}

export function siteConfigPayload(runtime: RuntimeConfig = getRuntimeConfig()): SiteConfigDto {
  const { icon, title, description, header_name, root, home, show, gallery, icp, mps, footer } =
    runtime.site;
  return {
    site: {
      icon: icon.startsWith("/assets/")
        ? `${staticResourceBaseUrl(runtime)}${icon.slice("/assets".length)}`
        : icon,
      title,
      description: description || title,
      header_name,
      root,
      home: {
        ...home,
        background: effectiveBackground(home.background)
      },
      show,
      gallery: {
        enabled: gallery.enabled,
        order: gallery.order
      },
      icp,
      mps,
      footer
    },
    embed: {
      enabled: effectiveEmbedAncestorSources(runtime).length > 0
    }
  };
}

export async function saveAppSettings(input: AppSettingsInput) {
  try {
    await updateRuntimeConfig(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ApiError(
        400,
        "validation_error",
        error.issues[0]?.message ?? "Validation failed",
        error.flatten()
      );
    }
    throw error;
  }
}
