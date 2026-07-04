import { useQuery } from "@tanstack/react-query";
import { api } from "./client.js";
import { adminApiBasePath, queryKeys } from "../constants.js";
import type { AdminUser, FacetOption, SiteSettings } from "../types.js";

export type SiteConfig = {
  site: SiteSettings;
  image_detail: { title_opens_image: boolean };
};

export type AuthState = {
  authenticated: boolean;
  username: string;
  role: AdminUser["role"] | "";
  csrf_token: string;
  captcha_enabled: boolean;
  login_background: string;
};

export type GalleryFacets = {
  devices: string[];
  brightnesses: string[];
  themes: FacetOption[];
  tags: FacetOption[];
  authors: Array<FacetOption & { link: string }>;
};

// site-config 与 gallery-facets 是「会话级近乎不变」的全局数据：只有在管理员保存站点设置、
// 改动主题 / 标签 / 作者或导入图片后才需要显式失效。这里关闭自动后台刷新，避免组件重挂、
// 路由切换和窗口重新聚焦时反复请求；gcTime 同设 Infinity，使离开画廊再返回也不必重新拉取。
// 任何页面都应改用下面两个 hook，而非各自内联 useQuery，既减少请求也统一了取数方式。
const sessionGlobalQuery = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false
} as const;

const sessionProbeHintKey = "site_session_hint";

export function hasSessionProbeHint() {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(sessionProbeHintKey) === "1";
  } catch {
    return false;
  }
}

export function rememberSessionProbeHint() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(sessionProbeHintKey, "1");
  } catch {
    // 忽略无痕模式或浏览器策略导致的本地存储失败。
  }
}

export function clearSessionProbeHint() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(sessionProbeHintKey);
  } catch {
    // 忽略无痕模式或浏览器策略导致的本地存储失败。
  }
}

const inlinedSiteConfig: SiteConfig | undefined = (() => {
  if (typeof document === "undefined") return undefined;
  const raw = document.getElementById("__site_config__")?.textContent;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SiteConfig;
  } catch {
    return undefined;
  }
})();

export function useSiteConfig() {
  return useQuery<SiteConfig>({
    queryKey: queryKeys.siteConfig,
    queryFn: () => api("/api/site-config"),
    initialData: inlinedSiteConfig,
    ...sessionGlobalQuery
  });
}

export function useGalleryFacets(enabled = true) {
  return useQuery<GalleryFacets>({
    queryKey: queryKeys.galleryFacets,
    queryFn: () => api("/api/gallery-facets"),
    enabled,
    ...sessionGlobalQuery
  });
}

// /me（登录态 + CSRF 探针）。集中到这里有两个目的：① 消除 AdminShell
// AccountSettings 四处内联 useQuery 的重复（它们共用同一 queryKey，本就去重为一次请求，但代码各写一遍）；
// ② 唯独给它关掉「窗口重新聚焦时重拉」——切回标签页不该反复打 /auth/me。会话过期不依赖焦点重拉兜底：
// 任何后台写操作命中 401 时由 api 层处理，登录/登出后各调用点用 refetch/invalidate 显式刷新；staleTime
// 沿用全局默认即可。enabled 供公共画廊在独立主题域（standalone）下跳过这次鉴权探测。
export function useAuthMe(enabled = true) {
  return useQuery<AuthState>({
    queryKey: queryKeys.me,
    queryFn: () => api(`${adminApiBasePath}/auth/me`),
    enabled,
    refetchOnWindowFocus: false
  });
}
