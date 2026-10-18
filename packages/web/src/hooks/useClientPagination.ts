import { useMemo, useState } from "react";

/** 一次读取的完整列表在前端分页；条目减少时在渲染中回落到最后一页，不先提交一帧越界的空页。 */
export function useClientPagination<T>(items: readonly T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  if (page > totalPages) setPage(totalPages);
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => items.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [items, currentPage, pageSize]
  );
  return { page: currentPage, setPage, totalPages, pageItems };
}
