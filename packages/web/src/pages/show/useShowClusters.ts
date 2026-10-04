import {
  readableFilterSearch,
  unsetThemeFilter,
  type PublicImageListResponseDto,
  type ShowClusterGroup,
  type ShowOrder
} from "@imageshow/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isApiClientError } from "../../lib/api/client.js";
import { readEditableImageSnapshots } from "../../lib/api/image-edit.js";
import { useGalleryFacets, useGalleryStats } from "../../lib/api/site-queries.js";
import {
  emptyGalleryFilters,
  imageBrowseApiSearchParams
} from "../../lib/gallery/gallery-query.js";
import {
  imageBatchTier,
  imageMatchesFilters,
  shuffledImageBatch
} from "../../lib/gallery/image-browse.js";
import type { EditableImageSnapshot } from "../../lib/types.js";
import { clusterShownCount } from "./show-cluster-layout.js";
import { showContinuationLimit } from "./show-data-pool.js";
import type { ShowImage } from "./show-layout.js";

/** 一个星团：一种分类下的图片流，保留槽位持有的图片与待轮换队列。 */
export type ShowCluster = {
  key: string;
  name: string;
  total: number;
  images: readonly ShowImage[];
};

type ClusterFeed = {
  key: string;
  slug: string;
  name: string;
  total: number;
  images: ShowImage[];
  retainedIds: ReadonlySet<string>;
  /** 编辑后已不属于这个分类的图片：在途或稍后的分页不再把它们接回来。 */
  departedIds: Set<string>;
  seen: Set<string>;
  cursor: string;
  started: boolean;
  failed: boolean;
  requesting: boolean;
  /** 连续没有接纳任何图片的续页次数。 */
  emptyPages: number;
};

const statsField = { theme: "themes", tag: "tags", author: "authors" } as const;
// 总览同时展示的星团数量；标签与作者可能很多，只取图片最多的若干个。
const maximumClusters = 12;
const firstPageTiers = [60, 120, 180] as const;
const maximumRetainedImages = 360;
const maximumConcurrentRequests = 3;
const noClusters: readonly ShowCluster[] = [];

/**
 * 星群模式的数据所有者：分类数量取自公开统计，名称取自会话词表，
 * 每个星团是一条带单一分类条件的公开列表游标流。此模式不叠加访客筛选。
 */
export function useShowClusters(group: ShowClusterGroup, order: ShowOrder, enabled: boolean) {
  const facets = useGalleryFacets(enabled);
  const stats = useGalleryStats("", enabled);
  const [generation, setGeneration] = useState(0);
  // 分组、排序或一次重试对应一个 dataKey：场景据此整体重建，而不是把新旧星群混在一起。
  const dataKey = `${group}:${order}:${generation}`;
  // settled：这一组星群的首批请求都已返回（成功或失败）。
  const [published, setPublished] = useState({ dataKey, clusters: noClusters, settled: false });
  const [failure, setFailure] = useState<unknown>(null);
  const feedsRef = useRef(new Map<string, ClusterFeed>());
  const queueRef = useRef<string[]>([]);
  const inFlightRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const removedImageIdsRef = useRef(new Set<string>());
  const confirmedImageEditsRef = useRef(new Map<string, ShowImage>());
  const targetedRequestsRef = useRef(new Map<string, AbortController>());

  const members = useMemo(() => {
    if (!enabled || !stats.data || !facets.data) return null;
    const names = new Map(facets.data[statsField[group]].map((entry) => [entry.slug, entry.display_name]));
    return stats.data[statsField[group]]
      .filter((entry) => entry.image_count > 0)
      .sort((left, right) => right.image_count - left.image_count)
      .slice(0, maximumClusters)
      .map((entry) => ({
        slug: entry.slug,
        name: names.get(entry.slug) || (entry.slug === unsetThemeFilter ? "未设置" : entry.slug),
        total: entry.image_count
      }));
    // 统计与词表的后台刷新不重建星群；切换分组、排序或重试才重新取图。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, group, Boolean(stats.data), Boolean(facets.data), generation]);

  const publish = useCallback(() => {
    setPublished({
      dataKey,
      settled: true,
      clusters: [...feedsRef.current.values()]
        .filter((feed) => feed.images.length > 0)
        .map((feed) => ({ key: feed.key, name: feed.name, total: feed.total, images: feed.images }))
    });
  }, [dataKey]);

  const pump = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    while (inFlightRef.current < maximumConcurrentRequests && queueRef.current.length > 0) {
      const feed = feedsRef.current.get(queueRef.current.shift()!);
      if (!feed || feed.requesting || feed.failed) continue;
      feed.requesting = true;
      inFlightRef.current += 1;
      const first = !feed.started;
      const limit = first
        ? imageBatchTier(clusterShownCount(feed.total) + 24, firstPageTiers)
        : showContinuationLimit;
      const read = (cursor: string) =>
        api<PublicImageListResponseDto<"show">>(
          `/api/images?${readableFilterSearch(
            imageBrowseApiSearchParams(
              { ...emptyGalleryFilters, [group]: feed.slug },
              order,
              { view: "show", limit, cursor, userAgent: window.navigator.userAgent }
            )
          )}`,
          { signal: controller.signal }
        );
      void read(feed.cursor)
        // 随机游标按天过期：过期后从头开始新的一轮。
        .catch((error: unknown) => {
          if (!isApiClientError(error) || error.code !== "cursor_expired") throw error;
          feed.seen.clear();
          return read("");
        })
        .then((response) => {
          if (controller.signal.aborted) return;
          // 管理操作的确认结果优先于已在途的分页，也覆盖从头轮换时再次出现的图片。
          const fresh = response.items
            .filter(
              (item) =>
                item.id &&
                !feed.seen.has(item.id) &&
                !feed.departedIds.has(item.id) &&
                !removedImageIdsRef.current.has(item.id)
            )
            .map((item) => confirmedImageEditsRef.current.get(item.id) ?? item);
          const accepted = order === "random" ? shuffledImageBatch(fresh) : fresh;
          for (const item of accepted) feed.seen.add(item.id);
          feed.started = true;
          feed.failed = false;
          feed.cursor = response.next_cursor ?? "";
          // 游标走到头：下一次续取从头开始新的一轮，一轮之内不重复。
          if (!response.next_cursor) feed.seen.clear();
          if (accepted.length === 0) {
            // 续页里的图都已删除或离开分类：场景等不到新的图片数组，由这里接着取，最多连续两次。
            if (!first && feed.emptyPages < 2) {
              feed.emptyPages += 1;
              queueRef.current.push(feed.key);
            }
          } else {
            feed.emptyPages = 0;
            const combined = [...feed.images, ...accepted];
            const held = new Map<string, ShowImage>();
            for (const image of combined)
              if (feed.retainedIds.has(image.id)) held.set(image.id, image);
            // 槽位仍持有的图必须留在 owner 中，否则队列截断后编辑、删除与回读会失去目标。
            const queued = combined.slice(-(maximumRetainedImages - held.size));
            for (const image of queued) held.delete(image.id);
            feed.images = [...held.values(), ...queued];
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          feed.failed = true;
          setFailure(error);
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          feed.requesting = false;
          inFlightRef.current -= 1;
          const feeds = [...feedsRef.current.values()];
          // 首批全部返回后一次发布，星群环只排一次；之后的续取随到随发。
          if (feeds.every((candidate) => candidate.started || candidate.failed)) publish();
          pump();
        });
    }
  }, [group, order, publish]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    feedsRef.current = new Map();
    queueRef.current = [];
    inFlightRef.current = 0;
    removedImageIdsRef.current.clear();
    confirmedImageEditsRef.current.clear();
    setPublished({ dataKey, clusters: noClusters, settled: members?.length === 0 });
    setFailure(null);
    if (members) {
      for (const member of members) {
        const key = `${group}:${member.slug}`;
        feedsRef.current.set(key, {
          key,
          ...member,
          images: [],
          retainedIds: new Set(),
          departedIds: new Set(),
          seen: new Set(),
          cursor: "",
          started: false,
          failed: false,
          requesting: false,
          emptyPages: 0
        });
        queueRef.current.push(key);
      }
      pump();
    }
    return () => {
      controller.abort();
      for (const request of targetedRequestsRef.current.values()) request.abort();
      targetedRequestsRef.current.clear();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [dataKey, group, members, pump]);

  /** 场景消耗到队列末尾附近时请求续取；全部同屏的小星团没有可轮换的图，不发请求。 */
  const needImages = useCallback(
    (key: string, retainedIds: readonly string[]) => {
      const feed = feedsRef.current.get(key);
      if (!feed) return;
      feed.retainedIds = new Set(retainedIds);
      if (!feed.started || feed.failed || feed.requesting || queueRef.current.includes(key)) return;
      if (feed.total <= clusterShownCount(feed.total)) return;
      queueRef.current.push(key);
      pump();
    },
    [pump]
  );

  const removeImage = useCallback(
    (imageId: string) => {
      removedImageIdsRef.current.add(imageId);
      confirmedImageEditsRef.current.delete(imageId);
      targetedRequestsRef.current.get(imageId)?.abort();
      targetedRequestsRef.current.delete(imageId);
      for (const feed of feedsRef.current.values()) {
        if (!feed.images.some((image) => image.id === imageId)) continue;
        feed.images = feed.images.filter((image) => image.id !== imageId);
        // 数量随之减一：场景据此区分“图片被删除”和“较早的图片滚出了保留范围”。
        feed.total = Math.max(0, feed.total - 1);
      }
      publish();
    },
    [publish]
  );

  const updateImage = useCallback(
    (snapshot: EditableImageSnapshot) => {
      if (removedImageIdsRef.current.has(snapshot.id)) return;
      targetedRequestsRef.current.get(snapshot.id)?.abort();
      targetedRequestsRef.current.delete(snapshot.id);
      const updated: ShowImage = {
        id: snapshot.id,
        title: snapshot.title,
        base_url: snapshot.base_url,
        width: snapshot.width,
        height: snapshot.height
      };
      confirmedImageEditsRef.current.set(snapshot.id, updated);
      for (const feed of feedsRef.current.values()) {
        const member = imageMatchesFilters(
          snapshot,
          { ...emptyGalleryFilters, [group]: feed.slug },
          ""
        );
        // 不属于这个分类的图片，即使此刻不在该星团里，在途的分页也不能把它接进来。
        if (member) feed.departedIds.delete(snapshot.id);
        else feed.departedIds.add(snapshot.id);
        if (!feed.images.some((image) => image.id === snapshot.id)) continue;
        if (member) {
          feed.images = feed.images.map((image) => (image.id === snapshot.id ? updated : image));
          continue;
        }
        // 改了主题、标签或作者后不再属于这个分类：离开该星团。它可能仍属于别的星团，不记为删除。
        feed.images = feed.images.filter((image) => image.id !== snapshot.id);
        feed.total = Math.max(0, feed.total - 1);
      }
      publish();
    },
    [group, publish]
  );

  const refreshImage = useCallback(
    (imageId: string) => {
      if (![...feedsRef.current.values()].some((feed) => feed.images.some((image) => image.id === imageId))) return;
      targetedRequestsRef.current.get(imageId)?.abort();
      const controller = new AbortController();
      targetedRequestsRef.current.set(imageId, controller);
      void readEditableImageSnapshots([imageId], controller.signal)
        .then((response) => {
          if (targetedRequestsRef.current.get(imageId) !== controller) return;
          const image = response.items.find((item) => item.id === imageId);
          if (image) updateImage(image);
          else removeImage(imageId);
        })
        .catch(() => {
          // 回读失败保留已提交图片，只有成功快照才能确认移除。
        })
        .finally(() => {
          if (targetedRequestsRef.current.get(imageId) === controller)
            targetedRequestsRef.current.delete(imageId);
        });
    },
    [removeImage, updateImage]
  );

  // 切换分组或排序后的第一次渲染里，状态还是上一组的星群：不属于当前 dataKey 的一律不交给场景。
  const current = enabled && published.dataKey === dataKey;
  const clusters = current ? published.clusters : noClusters;
  const settled = current && published.settled;
  const sourceError = (stats.data ? null : stats.error) ?? (facets.data ? null : facets.error) ?? null;
  const error = enabled ? (sourceError ?? (settled ? failure : null)) : null;
  return {
    clusters,
    dataKey,
    error,
    loading: enabled && !error && !settled,
    needImages,
    removeImage,
    updateImage,
    refreshImage,
    retry: () => {
      if (sourceError) {
        void stats.refetch({ cancelRefetch: false });
        void facets.refetch({ cancelRefetch: false });
      }
      setGeneration((current) => current + 1);
    }
  };
}
