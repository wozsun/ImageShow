import { useQuery } from "@tanstack/react-query";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";
import { queryKeys } from "./query-keys.js";
import type { FacetOption } from "../types.js";

type ImportVocabulary = {
  themes: FacetOption[];
  tags: FacetOption[];
  authors: FacetOption[];
};

// 导入词表只会在图片或词条写操作后变化，这些入口都会统一失效
// importVocabulary。会话内永久保留，避免编辑器和上传窗口反复挂载时重新读取。
export function useImportVocabulary(enabled = true) {
  return useQuery<ImportVocabulary>({
    queryKey: queryKeys.importVocabulary,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/import-vocabulary`, { signal }),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  });
}
