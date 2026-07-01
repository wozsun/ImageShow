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

// Live (lenient) slug character check for the create forms' red-border feedback: only the
// allowed character set, so a half-typed value isn't flagged for a trailing hyphen — the strict
// no-leading/trailing-hyphen rule (slugPattern) is enforced server-side. Shared by the
// theme/tag/author and the create-user (username) slug-style fields.
export const slugCharset = /^[a-z0-9-]+$/;
export const slugFormatHint = "只能包含小写字母、数字、连字符";

export const galleryRenderBatch = 12;
// How many leading gallery thumbnails (above the fold) load eagerly with high fetch priority so
// the LCP image isn't deferred by the lazy observer; everything after stays lazy. Tune freely.
export const eagerThumbnailCount = 12;
// IntersectionObserver pre-roll margins: how early a lazy thumbnail starts loading before it
// scrolls into view, and how early the infinite-scroll sentinel triggers the next page load.
export const galleryLazyRootMargin = "360px 0px";
export const gallerySentinelRootMargin = "280px 0px";
export const defaultSite: SiteSettings = {
  name: "ImageShow",
  domain: "img.example.com",
  icon_url: "/assets/brand/favicon.svg",
  root_redirect: "home",
  home_enabled: true,
  login_background: "",
  home_hero_background: ""
};

// The public-facing landing path. With the homepage enabled (default) it's /home;
// turning it off makes the gallery stand in wherever a "home" link points — the root
// redirect, the header brand, and the admin sidebar's view-site shortcut.
export function publicHomePath(site: { home_enabled?: boolean }): "/home" | "/gallery" {
  return site.home_enabled === false ? "/gallery" : "/home";
}
