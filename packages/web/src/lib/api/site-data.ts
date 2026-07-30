import { useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  api,
  authExpiredEvent,
  clearCsrfToken,
  setCsrfToken
} from "./client.js";
import { adminApiBasePath } from "../constants.js";
import { queryKeys } from "./query-keys.js";
import type {
  AdminPermission,
  AuthStateDto,
  GalleryFacetsDto,
  GalleryStatsDto,
  SiteConfigDto
} from "@imageshow/shared/browser";

export type SiteConfig = SiteConfigDto;

export type AuthState = AuthStateDto;
export type GalleryFacets = GalleryFacetsDto;
export type GalleryStats = GalleryStatsDto;

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

function synchronizeAuthenticatedSession(auth: AuthState) {
  if (auth.authenticated) {
    if (auth.csrf_token) setCsrfToken(auth.csrf_token);
    else clearCsrfToken();
    rememberSessionProbeHint();
    return;
  }
  clearCsrfToken();
  clearSessionProbeHint();
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
    queryFn: ({ signal }) => api("/api/site-config", { signal }),
    initialData: inlinedSiteConfig,
    ...sessionGlobalQuery
  });
}

export function useGalleryFacets(enabled = true) {
  return useQuery<GalleryFacets>({
    queryKey: queryKeys.galleryFacets,
    queryFn: ({ signal }) => api("/api/gallery-facets", { signal }),
    enabled,
    ...sessionGlobalQuery
  });
}

export function useGalleryStats(search = "") {
  return useQuery<GalleryStats>({
    queryKey: [...queryKeys.galleryStats, search],
    queryFn: ({ signal }) => api(
      search ? `/api/gallery-stats?${search}` : "/api/gallery-stats",
      { signal }
    ),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false
  });
}

// /me（登录态 + CSRF 探针）。集中到这里有两个目的：① 消除 AdminShell
// AccountSettings 四处内联 useQuery 的重复（它们共用同一 queryKey，本就去重为一次请求，但代码各写一遍）；
// ② 唯独给它关掉「窗口重新聚焦时重拉」——切回标签页不该反复打 /auth/me。会话过期不依赖焦点重拉兜底：
// 任何后台写操作命中 401 时由 api 层处理，登录/登出后各调用点用 refetch/invalidate 显式刷新；staleTime
// 保留一个很短的确认窗口，避免顶栏、详情和编辑器相继挂载时重复探测；写操作的 401
// 仍会立即清理并刷新。enabled 供无需鉴权探针的公共入口显式跳过请求。
export function useAuthMe(enabled = true) {
  const query = useQuery<AuthState>({
    queryKey: queryKeys.me,
    queryFn: async ({ signal }) => {
      const auth = await api<AuthState>(`${adminApiBasePath}/auth/me`, { signal });
      // /auth/me 是浏览器会话和 CSRF 的共同真相源。让查询在发布数据前完成同步，
      // 公共详情随后触发的受保护预取不会与 React effect 争抢一个空 token。
      synchronizeAuthenticatedSession(auth);
      return auth;
    },
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false
  });
  useEffect(() => {
    // 查询缓存可能先于当前调用方存在；挂载时也从缓存恢复会话副作用。
    if (enabled && query.data) synchronizeAuthenticatedSession(query.data);
  }, [enabled, query.data]);
  useEffect(() => {
    if (!enabled) return;
    const refreshAuth = () => {
      clearCsrfToken();
      clearSessionProbeHint();
      void query.refetch();
    };
    window.addEventListener(authExpiredEvent, refreshAuth);
    return () => window.removeEventListener(authExpiredEvent, refreshAuth);
  }, [enabled, query.refetch]);
  return query;
}

const noAdminPermissions: readonly AdminPermission[] = [];

export function useAdminPermissions(): readonly AdminPermission[] {
  const { data } = useAuthMe();
  return data?.permissions ?? noAdminPermissions;
}
