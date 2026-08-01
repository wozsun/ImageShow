import type {
  InfiniteData,
  QueryClient
} from "@tanstack/react-query";
import type {
  PublicImageListResponseDto
} from "@imageshow/shared/browser";
import { queryKeys } from "../../lib/api/query-keys.js";

export async function removeImageFromPublicImagesCache(
  client: QueryClient,
  imageQuery: string,
  imageId: string
) {
  const queryKey = [...queryKeys.publicImages, imageQuery] as const;
  // 下一页请求可能已捕获删除前的 InfiniteData。先只取消当前精确查询，避免
  // 迟到响应恢复已删除卡片；不失效或重放已加载的历史游标页。
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
