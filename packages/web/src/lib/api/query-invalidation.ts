import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../constants.js";

function invalidate(client: QueryClient, queryKeysToInvalidate: readonly (readonly unknown[])[]) {
  return Promise.all(queryKeysToInvalidate.map((queryKey) => client.invalidateQueries({ queryKey })));
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
