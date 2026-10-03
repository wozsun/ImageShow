import { z } from "zod";
import {
  builtInSiteIconPath,
  type AdminSettings,
  type RuntimeConfig,
  type SiteConfigDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { assertLocalImageHostForSite } from "../storage/backends/registry.ts";
import { parseRuntimeConfig } from "./runtime-config.ts";
import {
  getRuntimeConfig,
  replaceRuntimeConfig,
  runtimeConfigRevision,
  withRuntimeConfigWriteLease
} from "./runtime-config-store.ts";
import { effectiveEmbedAncestorSources } from "./embed-ancestors.ts";
import { staticResourceBaseUrl } from "./site-host.ts";

export function getIngestionMaxFileBytes() {
  return Math.floor(getRuntimeConfig().ingestion.max_file_size_mb * 1024 * 1024);
}

export function getIngestionMaxLongEdge() {
  return Math.floor(getRuntimeConfig().ingestion.max_long_edge);
}

export function getSettingsForAdmin(settings: RuntimeConfig = getRuntimeConfig()): AdminSettings {
  const { max_file_size_mb, max_long_edge, list_page_size } = settings.ingestion;
  const { max_items, browser_concurrency } = settings.upload;
  const { keep_original_link, auto_import, max_items: importMaxItems } = settings.import;
  return {
    ingestion: { max_file_size_mb, max_long_edge, list_page_size },
    upload: { max_items, browser_concurrency },
    import: { keep_original_link, auto_import, max_items: importMaxItems },
    weibo: { max_items: settings.weibo.max_items },
    admin: { image_page_size: settings.admin.image_page_size }
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

function effectiveSiteIcon(runtime: RuntimeConfig) {
  const icon = runtime.site.icon || builtInSiteIconPath;
  // Build assets follow the static resource address; other paths are used as configured.
  return icon.startsWith("/assets/")
    ? `${staticResourceBaseUrl(runtime)}${icon.slice("/assets".length)}`
    : icon;
}

export function siteConfigPayload(runtime: RuntimeConfig = getRuntimeConfig()): SiteConfigDto {
  const { title, description, header_name, root, home, show, gallery, icp, mps, footer } =
    runtime.site;
  return {
    site: {
      icon: effectiveSiteIcon(runtime),
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

export function saveAppSettings(value: unknown, revision: string) {
  return withRuntimeConfigWriteLease(async () => {
    if (revision !== runtimeConfigRevision()) {
      throw new ApiError(409, "config_revision_conflict",
        "配置已被其他页面或重新加载操作更新，本次未保存，草稿已保留。请记录需要保留的修改，再读取配置文件核对最新配置。");
    }
    let config: RuntimeConfig;
    try {
      config = parseRuntimeConfig(value);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        throw new ApiError(
          400,
          "validation_error",
          issue ? `${issue.path.join(".")}: ${issue.message}` : "配置值无效",
          error.flatten()
        );
      }
      throw error;
    }
    await assertLocalImageHostForSite(config.site.domain);
    return replaceRuntimeConfig(config);
  });
}
