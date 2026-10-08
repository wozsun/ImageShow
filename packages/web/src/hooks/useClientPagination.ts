import { useEffect, useMemo, useState } from "react";

/** 一次读取的完整列表在前端分页；条目减少时页码回落到最后一页。 */
export function useClientPagination<T>(items: readonly T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize]
  );
  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);
  return { page, setPage, totalPages, pageItems };
}
