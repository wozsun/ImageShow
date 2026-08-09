type CursorPage = {
  next_cursor: string | null;
};

export async function loadAdminImagePage<T extends CursorPage>({
  targetPage,
  currentPage,
  currentPageData,
  cursorHistory,
  load
}: {
  targetPage: number;
  currentPage: number;
  currentPageData: T | null;
  cursorHistory: readonly string[];
  load: (cursor: string) => Promise<T>;
}) {
  if (
    !Number.isSafeInteger(targetPage)
    || targetPage < 1
    || !Number.isSafeInteger(currentPage)
    || currentPage < 1
    || !cursorHistory.length
    || cursorHistory[0] !== ""
    || currentPage > cursorHistory.length
  ) {
    throw new Error("Invalid admin image page navigation state");
  }

  // 回退后不保留后续页边界；再次向前必须从当前响应的 next_cursor 重新补链。
  // 这样删除或编辑导致当前页边界变化时，不会复用旧游标造成重复或缺项。
  const retainedCursorCount = targetPage > currentPage
    ? currentPage
    : targetPage;
  const resolvedCursors = cursorHistory.slice(0, retainedCursorCount);
  while (resolvedCursors.length < targetPage) {
    const sourcePage = resolvedCursors.length;
    const sourceCursor = resolvedCursors[sourcePage - 1]!;
    const sourceData = sourcePage === currentPage
      && cursorHistory[currentPage - 1] === sourceCursor
      && currentPageData
      ? currentPageData
      : await load(sourceCursor);
    if (!sourceData.next_cursor) {
      throw new Error("Admin image page cursor chain ended early");
    }
    resolvedCursors.push(sourceData.next_cursor);
  }

  const cursor = resolvedCursors[targetPage - 1]!;
  const pageData = targetPage === currentPage
    && cursorHistory[currentPage - 1] === cursor
    && currentPageData
    ? currentPageData
    : await load(cursor);
  return { cursorHistory: resolvedCursors, pageData };
}
