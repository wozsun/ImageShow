import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";
import { queryKeys } from "./query-keys.js";
import type { IngestionVocabularyDto } from "@imageshow/shared/browser";

// 内容接入词表只会在图片或词条写操作后变化，这些入口都会统一失效
// ingestionVocabulary。会话内永久保留，避免编辑器和内容接入窗口反复挂载时重新读取。
export const ingestionVocabularyQueryOptions = queryOptions<IngestionVocabularyDto>({
  queryKey: queryKeys.ingestionVocabulary,
  queryFn: ({ signal }) => api(`${adminApiBasePath}/ingestion-vocabulary`, { signal }),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false
});

export function useIngestionVocabulary(enabled = true) {
  return useQuery({
    ...ingestionVocabularyQueryOptions,
    enabled,
  });
}
