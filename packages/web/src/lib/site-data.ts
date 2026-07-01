import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { adminApiBasePath, queryKeys } from "./constants.js";
import type { AuthState, GalleryOptions, SiteConfig } from "./types.js";

// site-config 与 gallery-options 是「会话级近乎不变」的全局数据：只有在管理员保存站点设置 / 改动
// 图片时才会变化，而那些写操作会显式 invalidate 对应查询（见 SettingsPage、ImageAdmin）。因此把
// 二者统一为「请求一次、全局共享」——staleTime 设为 Infinity，避免 React Query 默认的 staleTime:0
// 在每次组件重挂、路由切换、窗口重新聚焦时反复后台刷新；gcTime 同设 Infinity，使离开画廊再返回也不必
// 重新拉取。任何页面都应改用下面两个 hook，而非各自内联 useQuery，既减少请求也统一了取数方式。
const sessionGlobalQuery = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false
} as const;

// The server inlines the site config into the SPA document as a <script type="application/json">
// block (routes/spa.ts), so we seed React Query with it and skip the /api/site-config request on
// first load. Read once at module load; absent (e.g. `vite dev`, which serves the raw shell) ⇒
// undefined and the query fetches normally. The endpoint stays for the post-settings-save refetch.
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

export function useGalleryOptions() {
  return useQuery<GalleryOptions>({
    queryKey: queryKeys.galleryOptions,
    queryFn: () => api("/api/gallery-options"),
    ...sessionGlobalQuery
  });
}

// /me（登录态 + CSRF 探针）。集中到这里有两个目的：① 消除 AdminShell / GalleryPage / AppHeader /
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
