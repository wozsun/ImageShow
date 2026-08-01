import type { LogLevel, SiteVersionSettings } from "./common.ts";

export const rootRedirects = ["home", "gallery"] as const;
export type RootRedirect = (typeof rootRedirects)[number];

export const randomMethods = ["proxy", "redirect"] as const;
export type RandomMethod = (typeof randomMethods)[number];

export const galleryOrders = ["latest", "random"] as const;
export type GalleryOrder = (typeof galleryOrders)[number];

export type SiteHomeSettings = {
  enabled: boolean;
  background: string;
  banner_label: string;
  banner_title: string;
  tagline: string;
};

export type SiteGallerySettings = {
  default_limit: number;
  order: GalleryOrder;
};

export type RuntimeSiteSettings = {
  name: string;
  domain: string;
  icon_url: string;
  version: SiteVersionSettings;
  root_redirect: RootRedirect;
  home: SiteHomeSettings;
  gallery: SiteGallerySettings;
  random_default_method: RandomMethod;
  random_subdomain: string;
  static_subdomain: string;
  link_subdomain: string;
  robots_enabled: boolean;
};

export type EmbedSettings = {
  enabled: boolean;
  allowed_origins: string[];
};

export type UploadSettings = {
  max_items: number;
  max_file_size_mb: number;
  max_long_edge: number;
  list_page_size: number;
  concurrency: number;
  global_concurrency: number;
};

export type LinkImageSettings = {
  fill_original_url: boolean;
  auto_import: boolean;
  concurrency: number;
  global_concurrency: number;
  fetch_timeout_seconds: number;
  max_items: number;
};

export type WeiboSettings = {
  max_items: number;
  concurrency: number;
  global_concurrency: number;
  author_slugs: Record<string, string>;
};

export type NormalizeSettings = {
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

export type ImportSettings = {
  commit_concurrency: number;
  global_commit_concurrency: number;
  global_commit_byte_budget_mb: number;
};

export type ImageDetailSettings = {
  title_opens_image: boolean;
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
  upload: UploadSettings;
  link_image: LinkImageSettings;
  weibo: WeiboSettings;
  normalize: NormalizeSettings;
  thumbnail: ThumbnailSettings;
  import: ImportSettings;
  image_detail: ImageDetailSettings;
  admin: AdminPanelSettings;
  background_job: {
    move_cleanup_concurrency: number;
    theme_reassign_concurrency: number;
    migrate_concurrency: number;
  };
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
    counter_min: number;
    counter_max: number;
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
  | "icon_url"
  | "root_redirect"
  | "home"
  | "gallery"
  | "random_default_method"
>;

export type PublicSiteSettings = Pick<
  RuntimeSiteSettings,
  "name" | "icon_url" | "root_redirect" | "home"
> & {
  gallery: Pick<SiteGallerySettings, "order">;
};

export type AdminSiteSettings = Omit<
  SiteSettings,
  "domain" | "home" | "icon_url"
> & {
  home: Pick<
    SiteHomeSettings,
    "background" | "banner_label" | "banner_title"
  >;
};

export type AdminUploadSettings = Pick<
  UploadSettings,
  "max_items" | "max_file_size_mb" | "list_page_size" | "concurrency"
>;

export type AdminLinkImageSettings = Pick<
  LinkImageSettings,
  "fill_original_url" | "auto_import" | "concurrency" | "max_items"
>;

export type AdminWeiboSettings = Pick<WeiboSettings, "max_items">;
export type AdminImportSettings = Pick<ImportSettings, "commit_concurrency">;

export type AdminSettings = {
  site: AdminSiteSettings;
  upload: AdminUploadSettings;
  link_image: AdminLinkImageSettings;
  weibo: AdminWeiboSettings;
  normalize: NormalizeSettings;
  thumbnail: ThumbnailSettings;
  import: AdminImportSettings;
  image_detail: ImageDetailSettings;
  admin: AdminPanelSettings;
};

export type SiteConfigDto = {
  site: PublicSiteSettings;
  embed: Pick<EmbedSettings, "enabled">;
  image_detail: ImageDetailSettings;
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
