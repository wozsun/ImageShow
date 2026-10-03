import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./client.js";
import { requestWithDeadline } from "./request-deadline.js";
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
// 改动主题 / 标签 / 作者、内容接入完成，或统计出现词表未包含的成员时才需要显式失效。这里关闭自动后台刷新，避免组件重挂、
// 路由切换和窗口重新聚焦时反复请求；gcTime 同设 Infinity，使离开画廊再返回也不必重新拉取。
// 任何页面都应改用下面两个 hook，而非各自内联 useQuery，既减少请求也统一了取数方式。
const sessionGlobalQuery = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false
} as const;

const inlinedSiteConfig: SiteConfig | undefined = (() => {
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
    // 显式刷新必须重新验证 HTTP 缓存，不能再次用旧词表否定新标签。
    queryFn: ({ signal }) =>
      requestWithDeadline(
        (requestSignal) => api("/api/gallery-facets", { signal: requestSignal, cache: "no-cache" }),
        signal
      ),
    enabled,
    ...sessionGlobalQuery
  });
}

const facetMembers = ["themes", "tags", "authors"] as const;
const revalidatedUnknownMembers = new WeakMap<QueryClient, string>();

/**
 * Statistics are fresher than the session facets, so a counted member the
 * facets lack means the vocabulary changed. Revalidate the facets once while
 * the same set of members stays unknown; a rename keeps its slug and needs a reload.
 */
function revalidateFacetsForUnknownMembers(client: QueryClient, stats: GalleryStats) {
  const facets = client.getQueryData<GalleryFacets>(queryKeys.galleryFacets);
  if (!facets) return;
  const unknown = facetMembers
    .flatMap((field) => {
      const known = new Set(facets[field].map((entry) => entry.slug));
      return stats[field]
        .filter((member) => !known.has(member.slug))
        .map((member) => `${field}:${member.slug}`);
    })
    .join(",");
  if (!unknown) {
    revalidatedUnknownMembers.delete(client);
    return;
  }
  if (revalidatedUnknownMembers.get(client) === unknown) return;
  revalidatedUnknownMembers.set(client, unknown);
  void client.invalidateQueries({ queryKey: queryKeys.galleryFacets });
}

export function useGalleryStats(search = "", enabled = true) {
  return useQuery<GalleryStats>({
    queryKey: [...queryKeys.galleryStats, search],
    queryFn: async ({ signal, client }) => {
      const stats = await api<GalleryStats>(
        search ? `/api/gallery-stats?${search}` : "/api/gallery-stats",
        { signal }
      );
      revalidateFacetsForUnknownMembers(client, stats);
      return stats;
    },
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false
  });
}
