import type { LogLevel, SiteVersionSettings } from "./common.ts";
import type { ImportSourceTypeDto } from "./ingestion.ts";

export const siteRoots = ["home", "show", "gallery"] as const;
export type SiteRoot = (typeof siteRoots)[number];

export const homeBrowseTargets = ["gallery", "show"] as const;
export type HomeBrowseTarget = (typeof homeBrowseTargets)[number];

export const randomDefaultMethods = ["proxy", "redirect"] as const;
export type RandomDefaultMethod = (typeof randomDefaultMethods)[number];

export const randomMethods = [...randomDefaultMethods, "json"] as const;
export type RandomMethod = (typeof randomMethods)[number];

export const galleryOrders = ["latest", "random"] as const;
export type GalleryOrder = (typeof galleryOrders)[number];

export const showOrders = ["random", "latest", "oldest"] as const;
export type ShowOrder = (typeof showOrders)[number];

export const showModes = ["waterfall", "float"] as const;
export type ShowMode = (typeof showModes)[number];

export const showDensities = ["relaxed", "balanced", "dense"] as const;
export type ShowDensity = (typeof showDensities)[number];

export type SiteHomeSettings = {
  enabled: boolean;
  browse_target: HomeBrowseTarget;
  background: string;
  banner_label: string;
  banner_title: string;
};

export type SiteShowSettings = {
  enabled: boolean;
  autoplay: boolean;
  mode: ShowMode;
  density: ShowDensity;
  drift_speed: number;
  order: ShowOrder;
};

export type SiteGallerySettings = {
  enabled: boolean;
  limit: number;
  order: GalleryOrder;
  public_original_button: boolean;
};

export type RuntimeSiteSettings = {
  name: string;
  domain: string;
  description: string;
  icon: string;
  version: SiteVersionSettings;
  root: SiteRoot;
  home: SiteHomeSettings;
  show: SiteShowSettings;
  gallery: SiteGallerySettings;
  random_method: RandomDefaultMethod;
  static_subdomain: string;
  robots_enabled: boolean;
};

export type PublicPagePath = "/home" | "/show" | "/gallery";

type PublicPageAvailability = {
  root: SiteRoot;
  home: Pick<SiteHomeSettings, "enabled">;
  show: Pick<SiteShowSettings, "enabled">;
  gallery: Pick<SiteGallerySettings, "enabled">;
};

export function publicPageEnabled(
  site: PublicPageAvailability,
  root: SiteRoot
) {
  if (root === "home") return site.home.enabled;
  if (root === "show") return site.show.enabled;
  return site.gallery.enabled;
}

export function publicRootPath(
  site: PublicPageAvailability
): PublicPagePath | null {
  if (publicPageEnabled(site, site.root)) return `/${site.root}`;
  for (const fallback of ["gallery", "show", "home"] as const) {
    if (publicPageEnabled(site, fallback)) return `/${fallback}`;
  }
  return null;
}

export function publicHomeBrowsePath(
  site: {
    home: Pick<SiteHomeSettings, "browse_target">;
    show: Pick<SiteShowSettings, "enabled">;
    gallery: Pick<SiteGallerySettings, "enabled">;
  },
  embedded = false
): Extract<PublicPagePath, "/show" | "/gallery"> | "/embed/show" | "/embed/gallery" | null {
  for (const target of [site.home.browse_target, "gallery", "show"] as const) {
    if (site[target].enabled) return embedded ? `/embed/${target}` : `/${target}`;
  }
  return null;
}

export type EmbedSettings = {
  enabled: boolean;
  allowed_origins: string[];
};

export type IngestionSettings = {
  max_file_size_mb: number;
  max_long_edge: number;
  list_page_size: number;
  commit_concurrency: number;
};

export type UploadSettings = {
  max_items: number;
  browser_concurrency: number;
  raw_concurrency: number;
};

export type ImportSettings = {
  keep_original_link: ImportSourceTypeDto[];
  auto_import: boolean;
  fetch_timeout_seconds: number;
  max_items: number;
};

export type WeiboSettings = {
  max_items: number;
  source_enabled: boolean;
  request_delay_seconds: [number, number];
};

export type NormalizeSettings = {
  concurrency: number;
  quality: number;
  quality_step: number;
  min_quality: number;
  max_long_edge: number;
  max_size_kb: number;
  skip_webp_under_kb: number;
};

export type ThumbnailSettings = {
  long_edge: number;
  quality: number;
};

export type AdminPanelSettings = {
  login_background: string;
  image_page_size: number;
  recent_uploads: number;
  show_unset_theme_card: boolean;
};

export type RuntimeConfig = {
  site: RuntimeSiteSettings;
  embed: EmbedSettings;
  ingestion: IngestionSettings;
  upload: UploadSettings;
  import: ImportSettings;
  weibo: WeiboSettings;
  normalize: NormalizeSettings;
  thumbnail: ThumbnailSettings;
  admin: AdminPanelSettings;
  security: {
    session_ttl_seconds: number;
    login_failure_window_seconds: number;
    login_max_failures: number;
    login_global_window_seconds: number;
    login_global_max_attempts: number;
  };
  altcha: {
    enabled: boolean;
    ttl_seconds: number;
    cost: number;
    counter_range: [number, number];
  };
  log: {
    level: LogLevel;
    max_size_mb: number;
    max_files: number;
  };
};

export type SiteSettings = Pick<
  RuntimeSiteSettings,
  | "name"
  | "domain"
  | "icon"
  | "root"
  | "home"
  | "random_method"
> & {
  gallery: Pick<SiteGallerySettings, "enabled" | "limit" | "order">;
  show: SiteShowSettings;
};

export type PublicSiteSettings = Pick<
  RuntimeSiteSettings,
  "name" | "description" | "icon" | "root" | "home"
> & {
  gallery: Pick<
    SiteGallerySettings,
    "enabled" | "order" | "public_original_button"
  >;
  show: SiteShowSettings;
  static_url: string;
};

export type AdminSiteSettings = Omit<
  SiteSettings,
  "domain" | "home" | "icon" | "show" | "gallery"
> & {
  gallery: Pick<SiteGallerySettings, "limit" | "order">;
  home: Pick<
    SiteHomeSettings,
    "background" | "banner_label" | "banner_title"
  >;
};

export type AdminIngestionSettings = Pick<
  IngestionSettings,
  | "max_file_size_mb"
  | "max_long_edge"
  | "list_page_size"
  | "commit_concurrency"
>;

export type AdminUploadSettings = Pick<
  UploadSettings,
  | "max_items"
  | "browser_concurrency"
>;

export type AdminImportSettings = Pick<
  ImportSettings,
  "keep_original_link" | "auto_import" | "max_items"
>;

export type AdminWeiboSettings = Pick<
  WeiboSettings,
  "max_items"
>;

export type AdminNormalizeSettings = Omit<
  NormalizeSettings,
  "quality_step"
>;

export type AdminSettings = {
  site: AdminSiteSettings;
  ingestion: AdminIngestionSettings;
  upload: AdminUploadSettings;
  import: AdminImportSettings;
  weibo: AdminWeiboSettings;
  normalize: AdminNormalizeSettings;
  thumbnail: ThumbnailSettings;
  admin: AdminPanelSettings;
};

export type SiteConfigDto = {
  site: PublicSiteSettings;
  embed: Pick<EmbedSettings, "enabled">;
};

export type RuntimeConfigChangeSummaryDto = {
  access_changes: Array<"site.domain">;
};

export type AdminSettingsResponseDto = {
  settings: AdminSettings;
};

export type RuntimeConfigResponseDto = {
  config: RuntimeConfig;
};

export type RuntimeConfigValidationResponseDto = {
  changes: RuntimeConfigChangeSummaryDto;
};
