import type { SiteSettings } from "./types.js";
export { adminApiBasePath, adminBasePath, adminImagePageLimit, reservedSubdomains } from "@imageshow/shared";

export const queryKeys = {
  siteConfig: ["site-config"] as const,
  galleryOptions: ["gallery-options"] as const,
  adminImages: ["admin-images"] as const,
  settings: ["settings"] as const,
  me: ["me"] as const
};

export const galleryRenderBatch = 12;
export const defaultSite: SiteSettings = {
  name: "ImageShow",
  domain: "img.example.com",
  icon_url: "/assets/brand/favicon.svg",
  root_redirect: "home"
};
