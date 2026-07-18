import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../constants.js";

function invalidate(client: QueryClient, queryKeysToInvalidate: readonly (readonly unknown[])[]) {
  return Promise.all(queryKeysToInvalidate.map((queryKey) => client.invalidateQueries({ queryKey })));
}

function removeQueries(client: QueryClient, queryKeysToRemove: readonly (readonly unknown[])[]) {
  for (const queryKey of queryKeysToRemove) client.removeQueries({ queryKey });
}

export function clearAdminCacheAfterLogin(client: QueryClient) {
  removeQueries(client, [
    // 清除整个偏好 key 前缀，不依赖登录表单里的原始用户名与服务端最终会话名完全一致。
    queryKeys.adminPreferences,
    queryKeys.importVocabulary,
    queryKeys.settings,
    queryKeys.overview,
    queryKeys.adminImages,
    queryKeys.adminImageInfo,
    queryKeys.tags,
    queryKeys.themes,
    queryKeys.authors,
    queryKeys.users,
    queryKeys.logs,
    ["storage-backends"],
    ["storage-options"]
  ]);
}

export function invalidateImageData(client: QueryClient) {
  return invalidate(client, [
    queryKeys.publicImages,
    queryKeys.publicImageDetail,
    queryKeys.galleryFacets,
    queryKeys.adminImages,
    queryKeys.adminImageInfo,
    queryKeys.overview,
    queryKeys.themes,
    queryKeys.tags,
    queryKeys.authors,
    queryKeys.importVocabulary
  ]);
}

export function invalidateStorageData(client: QueryClient) {
  return invalidate(client, [
    ["storage-backends"],
    ["storage-options"],
    queryKeys.overview,
    queryKeys.publicImages,
    queryKeys.publicImageDetail,
    queryKeys.adminImages,
    queryKeys.adminImageInfo
  ]);
}

export function invalidateRuntimeData(client: QueryClient) {
  return invalidate(client, [
    queryKeys.settings,
    queryKeys.siteConfig,
    queryKeys.me,
    ["storage-backends"],
    ["storage-options"],
    queryKeys.overview,
    queryKeys.publicImages,
    queryKeys.publicImageDetail,
    queryKeys.galleryFacets
  ]);
}
