import type { NormalizeProfile } from "./image-variants.ts";
import type { LogLevel } from "./log-levels.ts";
import type { ImportSourceTypeDto } from "./ingestion.ts";
import type { PublicImageOrder, RandomImageSize, RandomFallbackDimension } from "./images.ts";

// Shipped with the Web build; used when site.icon is empty.
export const builtInSiteIconPath = "/assets/brand/favicon.svg";

export const siteRoots = ["home", "show", "gallery"] as const;
type SiteRoot = (typeof siteRoots)[number];

export const homeBrowseTargets = ["gallery", "show"] as const;
type HomeBrowseTarget = (typeof homeBrowseTargets)[number];

export const randomDefaultMethods = ["proxy", "redirect"] as const;
export type RandomDefaultMethod = (typeof randomDefaultMethods)[number];

export const randomMethods = [...randomDefaultMethods, "json"] as const;
export type RandomMethod = (typeof randomMethods)[number];

export type GalleryOrder = PublicImageOrder;
export type ShowOrder = PublicImageOrder;

export const showModes = ["waterfall", "float", "cluster"] as const;
export type ShowMode = (typeof showModes)[number];

/** 星群模式把图片按一种分类聚成星团；分组维度是访客的浏览选择，不是站点配置。 */
export const showClusterGroups = ["theme", "tag", "author"] as const;
export type ShowClusterGroup = (typeof showClusterGroups)[number];

export const showDensities = ["relaxed", "balanced", "dense"] as const;
export type ShowDensity = (typeof showDensities)[number];

type SiteHomeSettings = {
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

type SiteGallerySettings = {
  enabled: boolean;
  order: GalleryOrder;
};

type RuntimeSiteSettings = {
  domain: string;
  additional_domains: string[];
  icon: string;
  title: string;
  description: string;
  header_name: string;
  version: SiteVersionSettings;
  root: SiteRoot;
  home: SiteHomeSettings;
  show: SiteShowSettings;
  gallery: SiteGallerySettings;
  public_original: boolean;
  random_method: RandomDefaultMethod;
  random_size: RandomImageSize;
  random_max_items: number;
  random_fallback_order: RandomFallbackDimension[];
  assets_base_url: string;
  /** Extra script sources for every page document, as CSP host sources. */
  script_sources: string[];
  robots_enabled: boolean;
  icp: string;
  mps: string;
  footer: string;
};

type PublicPagePath = "/home" | "/show" | "/gallery";

type PublicPageAvailability = {
  root: SiteRoot;
  home: Pick<SiteHomeSettings, "enabled">;
  show: Pick<SiteShowSettings, "enabled">;
  gallery: Pick<SiteGallerySettings, "enabled">;
};

function publicPageEnabled(
  site: PublicPageAvailability,
  root: SiteRoot
) {
  if (root === "home") return site.home.enabled;
  if (root === "show") return site.show.enabled;
  return site.gallery.enabled;
}

export function publicRootPath(site: PublicPageAvailability): PublicPagePath | null {
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

/**
 * The public page a path shows under the enable and fallback rules: the path
 * itself, the page it redirects to, or null when no public page is enabled.
 * The root path and unknown paths show the root page. The routes, the
 * startup load and the server's document preloads all follow it.
 */
export function publicPageTarget(
  site: PublicPageAvailability & { home: Pick<SiteHomeSettings, "enabled" | "browse_target"> },
  embedEnabled: boolean,
  path: string
): PublicPagePath | `/embed/${SiteRoot}` | null {
  const rootPath = publicRootPath(site);
  const page = /^\/(home|show|gallery)$/.exec(path)?.[1] as SiteRoot | undefined;
  if (page) return publicPageEnabled(site, page) ? `/${page}` : rootPath;
  const embedded = /^\/embed\/(home|show|gallery)$/.exec(path)?.[1] as SiteRoot | undefined;
  if (!embedded || !embedEnabled) return rootPath;
  if (publicPageEnabled(site, embedded)) return `/embed/${embedded}`;
  return embedded === "home" ? publicHomeBrowsePath(site, true) ?? rootPath : rootPath;
}

type EmbedSettings = {
  enabled: boolean;
  allowed_origins: string[];
};

type IngestionSettings = {
  max_file_size_mb: number;
  max_long_edge: number;
  list_page_size: number;
  commit_concurrency: number;
};

type UploadSettings = {
  max_items: number;
  browser_concurrency: number;
  raw_concurrency: number;
};

type ImportSettings = {
  keep_original_link: ImportSourceTypeDto[];
  auto_import: boolean;
  fetch_timeout_seconds: number;
  max_items: number;
};

type WeiboSettings = {
  max_items: number;
  source_enabled: boolean;
  request_delay_seconds: [number, number];
};

type NormalizeSettings = NormalizeProfile & { concurrency: number };

type AdminPanelSettings = {
  login_background: string;
  image_page_size: number;
  recent_uploads: number;
};

export type RuntimeConfig = {
  site: RuntimeSiteSettings;
  embed: EmbedSettings;
  ingestion: IngestionSettings;
  upload: UploadSettings;
  import: ImportSettings;
  weibo: WeiboSettings;
  normalize: NormalizeSettings;
  admin: AdminPanelSettings;
  security: {
    session_ttl_seconds: number;
    login_failure_window_seconds: number;
    login_max_failures: number;
    login_global_window_seconds: number;
    login_global_max_attempts: number;
    random_window_seconds: number;
    random_max_requests: number;
    random_limit_max_requests: number;
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

export type PublicSiteSettings = Pick<
  RuntimeSiteSettings,
  "icon" | "title" | "description" | "header_name" | "root" | "home" | "icp" | "mps" | "footer"
> & {
  gallery: Pick<SiteGallerySettings, "enabled" | "order">;
  show: SiteShowSettings;
};

type AdminIngestionSettings = Pick<
  IngestionSettings,
  "max_file_size_mb" | "max_long_edge" | "list_page_size"
>;

type AdminUploadSettings = Pick<UploadSettings, "max_items" | "browser_concurrency">;

type AdminImportSettings = Pick<
  ImportSettings,
  "keep_original_link" | "auto_import" | "max_items"
>;

type AdminWeiboSettings = Pick<WeiboSettings, "max_items">;

export type AdminSettings = {
  ingestion: AdminIngestionSettings;
  upload: AdminUploadSettings;
  import: AdminImportSettings;
  weibo: AdminWeiboSettings;
  admin: Pick<AdminPanelSettings, "image_page_size">;
};

export type SiteConfigDto = {
  site: PublicSiteSettings;
  embed: Pick<EmbedSettings, "enabled">;
};

export type AdminSettingsResponseDto = {
  settings: AdminSettings;
};

export type RuntimeConfigResponseDto = AdminSettingsResponseDto & {
  config: RuntimeConfig;
  revision: string;
};

export type RuntimeConfigSaveRequestDto = {
  config: RuntimeConfig;
  revision: string;
};

export type SiteVersionSettings = {
  enabled: boolean;
  link_enabled: boolean;
};
