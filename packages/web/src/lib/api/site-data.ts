import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./client.js";
import { queryKeys } from "./query-keys.js";
import type {
  GalleryFacetsDto,
  GalleryStatsDto,
  SiteConfigDto
} from "@imageshow/shared/browser";

export type SiteConfig = SiteConfigDto;

export type GalleryFacets = GalleryFacetsDto;
export type GalleryStats = GalleryStatsDto;

// site-config 与 gallery-facets 是「会话级近乎不变」的全局数据：只有在管理员保存站点设置、
// 改动主题 / 标签 / 作者或内容接入完成后才需要显式失效。这里关闭自动后台刷新，避免组件重挂、
// 路由切换和窗口重新聚焦时反复请求；gcTime 同设 Infinity，使离开画廊再返回也不必重新拉取。
// 任何页面都应改用下面两个 hook，而非各自内联 useQuery，既减少请求也统一了取数方式。
const sessionGlobalQuery = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false
} as const;

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
