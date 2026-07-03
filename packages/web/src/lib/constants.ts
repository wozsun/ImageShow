import type { SiteSettings } from "./types.js";
export { adminApiBasePath, adminBasePath, reservedSubdomains, slugPattern } from "@imageshow/shared";

export const queryKeys = {
  siteConfig: ["site-config"] as const,
  galleryOptions: ["gallery-options"] as const,
  overview: ["admin-overview"] as const,
  adminImages: ["admin-images"] as const,
  tags: ["tags"] as const,
  themes: ["themes"] as const,
  authors: ["authors"] as const,
  users: ["users"] as const,
  settings: ["settings"] as const,
  me: ["me"] as const
};

export const slugCharset = /^[a-z0-9-]+$/;
export const slugFormatHint = "只能包含小写字母、数字、连字符";

export const galleryRenderBatch = 12;

export const eagerThumbnailCount = 12;

export const galleryLazyRootMargin = "360px 0px";
export const gallerySentinelRootMargin = "280px 0px";
export const defaultSite: SiteSettings = {
  name: "ImageShow",
  domain: "img.example.com",
  icon_url: "/assets/brand/favicon.svg",
  root_redirect: "home",
  home: {
    enabled: true,
    tagline: "个人图片管理、画廊展示和随机图片 API。",
    hero_background: "",
    preview_delay_ms: 1000
  },
  gallery: { default_limit: 60, order: "random" },
  random_default_method: "redirect"
};

export function publicHomePath(site: { home?: { enabled?: boolean } }): "/home" | "/gallery" {
  return site.home?.enabled === false ? "/gallery" : "/home";
}
