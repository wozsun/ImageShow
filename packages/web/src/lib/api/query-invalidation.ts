import type { QueryClient } from "@tanstack/react-query";
import type {
  AdminImageListItemDto,
  ImportVocabularyDto
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
    queryKeys.adminCheckStatus,
    queryKeys.adminImages,
    queryKeys.adminImageInfo,
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

function importedVocabularyChanged(
  vocabulary: ImportVocabularyDto,
  items: readonly AdminImageListItemDto[]
) {
  const themes = new Set(vocabulary.themes.map(({ slug }) => slug));
  const tags = new Set(vocabulary.tags.map(({ slug }) => slug));
  const authors = new Set(vocabulary.authors.map(({ slug }) => slug));
  return items.some((item) => (
    !themes.has(item.theme)
    || (item.author !== "" && !authors.has(item.author))
    || item.tags.some((tag) => !tags.has(tag))
  ));
}

export function invalidateImageDataAfterImport(
  client: QueryClient,
  items: readonly AdminImageListItemDto[]
) {
  const vocabulary = client.getQueryData<ImportVocabularyDto>(
    queryKeys.importVocabulary
  );
  const vocabularyQueryExists = Boolean(
    client.getQueryState(queryKeys.importVocabulary)
  );
  const hasTags = items.some((item) => item.tags.length > 0);
  const hasAuthors = items.some((item) => item.author !== "");
  return invalidate(client, [
    queryKeys.publicImages,
    queryKeys.galleryFacets,
    queryKeys.galleryStats,
    queryKeys.adminImages,
    queryKeys.overview,
    queryKeys.themes,
    ...(hasTags ? [queryKeys.tags] : []),
    ...(hasAuthors ? [queryKeys.authors] : []),
    ...(vocabularyQueryExists && (
      !vocabulary || importedVocabularyChanged(vocabulary, items)
    ) ? [queryKeys.importVocabulary] : [])
  ]);
}

export async function invalidateImageDataAfterTrash(
  client: QueryClient,
  imageIds: string[]
) {
  // 当前公开详情在移入回收站后必然返回 404。先终止可能尚未完成的旧读取，但不改变
  // 它的 freshness；详情关闭后 gcTime: 0 会自然回收它。
  await Promise.all(imageIds.map((imageId) => client.cancelQueries({
    queryKey: [...queryKeys.publicImageDetail, imageId],
    exact: true
  })));
  // 查询所有者会在 mutation 提交时先把当前 ID 集合设为 disabled。这里不能再把仍
  // active 的详情标为 stale，否则关闭动画期间的窗口聚焦或网络重连仍可能读取 404。
  // 详情卸载后由 gcTime: 0 回收。当前公开列表已在 mutation 成功边界精确移除
  // 目标 ID，不能把公开数据窗口的临时页全部标为 stale 并重放历史游标；
  // 其他投影照常失效。
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
    queryKeys.galleryFacets
  ]);
}
