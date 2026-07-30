import type {
  InfiniteData,
  QueryClient
} from "@tanstack/react-query";
import type {
  PublicImageListResponseDto
} from "@imageshow/shared/browser";
import { queryKeys } from "./query-keys.js";

function invalidate(client: QueryClient, queryKeysToInvalidate: readonly (readonly unknown[])[]) {
  return Promise.all(queryKeysToInvalidate.map((queryKey) => client.invalidateQueries({ queryKey })));
}

function removeQueries(client: QueryClient, queryKeysToRemove: readonly (readonly unknown[])[]) {
  for (const queryKey of queryKeysToRemove) client.removeQueries({ queryKey });
}

const imageDataQueryKeys = [
  queryKeys.publicImages,
  queryKeys.publicImageDetail,
  queryKeys.galleryFacets,
  queryKeys.galleryStats,
  queryKeys.adminImages,
  queryKeys.adminImageInfo,
  queryKeys.adminImageEditSnapshot,
  queryKeys.overview,
  queryKeys.themes,
  queryKeys.tags,
  queryKeys.authors,
  queryKeys.importVocabulary
] as const;

export function clearAdminCacheAfterLogin(client: QueryClient) {
  removeQueries(client, [
    // 清除整个偏好 key 前缀，不依赖登录表单里的原始用户名与服务端最终会话名完全一致。
    queryKeys.adminPreferences,
    queryKeys.importVocabulary,
    queryKeys.settings,
    queryKeys.overview,
    queryKeys.adminImages,
    queryKeys.adminImageInfo,
    queryKeys.adminImageEditSnapshot,
    queryKeys.tags,
    queryKeys.themes,
    queryKeys.authors,
    queryKeys.users,
    queryKeys.logs,
    queryKeys.storageBackends,
    queryKeys.storageOptions
  ]);
}

export function invalidateImageData(client: QueryClient) {
  return invalidate(client, imageDataQueryKeys);
}

export async function removeImageFromPublicImagesCache(
  client: QueryClient,
  imageQuery: string,
  imageId: string
) {
  const queryKey = [...queryKeys.publicImages, imageQuery] as const;
  // A next-page response may have captured the pre-delete InfiniteData. Stop
  // only this exact request before editing the cache so a late response cannot
  // restore the deleted card. This does not invalidate or replay loaded pages.
  await client.cancelQueries({
    queryKey,
    exact: true
  });
  let removed = false;
  client.setQueryData<InfiniteData<PublicImageListResponseDto, string>>(
    queryKey,
    (current) => {
      if (!current) return current;
      const pages = current.pages.map((page) => {
        if (!page.items.some((item) => item.id === imageId)) return page;
        removed = true;
        return {
          ...page,
          items: page.items.filter((item) => item.id !== imageId)
        };
      });
      return removed ? { ...current, pages } : current;
    }
  );
  return removed;
}

export async function invalidateImageDataAfterDelete(
  client: QueryClient,
  imageId: string
) {
  const deletedDetailKey = [...queryKeys.publicImageDetail, imageId] as const;
  // 当前公开详情在删除后必然返回 404。先终止可能尚未完成的旧读取，但不改变
  // 它的 freshness；详情关闭后 gcTime: 0 会自然回收它。
  await client.cancelQueries({
    queryKey: deletedDetailKey,
    exact: true
  });
  // 查询所有者会在 mutation 提交时先把当前 ID 设为 disabled。这里不能再把仍
  // active 的详情标为 stale，否则关闭动画期间的窗口聚焦或网络重连仍可能读取 404。
  // 详情卸载后由 gcTime: 0 回收。当前公开列表已在 mutation 成功边界精确移除
  // 目标 ID，不能把无限查询全部标为 stale 并重放历史游标页；其他投影照常失效。
  return invalidate(
    client,
    imageDataQueryKeys.filter(
      (queryKey) => (
        queryKey !== queryKeys.publicImages
        && queryKey !== queryKeys.publicImageDetail
      )
    )
  );
}

export function invalidateStorageData(client: QueryClient) {
  return invalidate(client, [
    queryKeys.storageBackends,
    queryKeys.storageOptions,
    queryKeys.overview,
    queryKeys.publicImages,
    queryKeys.publicImageDetail,
    queryKeys.adminImages,
    queryKeys.adminImageInfo,
    queryKeys.adminImageEditSnapshot
  ]);
}

export function invalidateRuntimeData(client: QueryClient) {
  return invalidate(client, [
    queryKeys.settings,
    queryKeys.siteConfig,
    queryKeys.me,
    queryKeys.storageBackends,
    queryKeys.storageOptions,
    queryKeys.overview,
    queryKeys.publicImages,
    queryKeys.publicImageDetail,
    queryKeys.adminImageEditSnapshot,
    queryKeys.galleryFacets
  ]);
}
