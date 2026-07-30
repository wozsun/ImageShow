import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";
import { queryKeys } from "./query-keys.js";
import type { ImportVocabularyDto } from "@imageshow/shared/browser";

// 导入词表只会在图片或词条写操作后变化，这些入口都会统一失效
// importVocabulary。会话内永久保留，避免编辑器和上传窗口反复挂载时重新读取。
export const importVocabularyQueryOptions = queryOptions<ImportVocabularyDto>({
  queryKey: queryKeys.importVocabulary,
  queryFn: ({ signal }) => api(`${adminApiBasePath}/import-vocabulary`, { signal }),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false
});

export function useImportVocabulary(enabled = true) {
  return useQuery({
    ...importVocabularyQueryOptions,
    enabled,
  });
}
