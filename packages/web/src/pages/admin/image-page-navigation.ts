type CursorPage = {
  next_cursor: string | null;
};

export const adminImagePageBoundaryBuildLimit = 20;

export type AdminImagePageNavigationProgress = {
  targetPage: number;
  resolvedBoundaries: number;
  totalBoundaries: number;
  loadingTarget: boolean;
};

export function adminImagePageNavigationStatus(
  progress: AdminImagePageNavigationProgress | null
) {
  if (!progress) return null;
  if (progress.totalBoundaries === 0) {
    return `正在加载目标第 ${progress.targetPage} 页`;
  }
  const boundaryStatus = `目标第 ${progress.targetPage} 页 · 已建立 `
    + `${progress.resolvedBoundaries} / ${progress.totalBoundaries} 个边界`;
  return progress.loadingTarget
    ? `${boundaryStatus} · 正在加载目标页`
    : boundaryStatus;
}

function retainedAdminImageCursorCount({
  targetPage,
  currentPage,
  cursorHistory
}: {
  targetPage: number;
  currentPage: number;
  cursorHistory: readonly string[];
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
  return targetPage > currentPage ? currentPage : targetPage;
}

export function adminImagePageBoundaryBuildCount({
  targetPage,
  currentPage,
  cursorHistory
}: {
  targetPage: number;
  currentPage: number;
  cursorHistory: readonly string[];
}) {
  return targetPage - retainedAdminImageCursorCount({
    targetPage,
    currentPage,
    cursorHistory
  });
}

export function adminImagePageRetreatTarget({
  isFetching,
  hasPageData,
  itemCount,
  currentPage,
  totalPages
}: {
  isFetching: boolean;
  hasPageData: boolean;
  itemCount: number;
  currentPage: number;
  totalPages: number;
}) {
  if (
    isFetching
    || !hasPageData
    || currentPage <= 1
    || (itemCount > 0 && currentPage <= totalPages)
  ) {
    return null;
  }
  return Math.max(1, Math.min(currentPage - 1, totalPages));
}

export async function loadAdminImagePage<T extends CursorPage>({
  targetPage,
  currentPage,
  currentPageData,
  cursorHistory,
  load,
  signal,
  maxBoundaryBuilds = adminImagePageBoundaryBuildLimit,
  onProgress
}: {
  targetPage: number;
  currentPage: number;
  currentPageData: T | null;
  cursorHistory: readonly string[];
  load: (cursor: string) => Promise<T>;
  signal?: AbortSignal;
  maxBoundaryBuilds?: number;
  onProgress?: (progress: AdminImagePageNavigationProgress) => void;
}) {
  if (!Number.isSafeInteger(maxBoundaryBuilds) || maxBoundaryBuilds < 0) {
    throw new Error("Invalid admin image page boundary build limit");
  }
  const retainedCursorCount = retainedAdminImageCursorCount({
    targetPage,
    currentPage,
    cursorHistory
  });
  const totalBoundaries = targetPage - retainedCursorCount;
  if (totalBoundaries > maxBoundaryBuilds) {
    throw new Error(
      `Admin image page navigation requires ${totalBoundaries} new boundaries; `
      + `limit is ${maxBoundaryBuilds}`
    );
  }
  signal?.throwIfAborted();
  // 回退后不保留后续页边界；再次向前必须从当前响应的 next_cursor 重新补链。
  // 这样删除或编辑导致当前页边界变化时，不会复用旧游标造成重复或缺项。
  const resolvedCursors = cursorHistory.slice(0, retainedCursorCount);
  let resolvedBoundaries = 0;
  let requestCount = 0;
  const loadWithinLimit = async (cursor: string) => {
    if (requestCount >= maxBoundaryBuilds) {
      throw new Error(
        `Admin image page navigation request limit is ${maxBoundaryBuilds}`
      );
    }
    requestCount += 1;
    return load(cursor);
  };
  onProgress?.({
    targetPage,
    resolvedBoundaries,
    totalBoundaries,
    loadingTarget: false
  });
  while (resolvedCursors.length < targetPage) {
    signal?.throwIfAborted();
    const sourcePage = resolvedCursors.length;
    const sourceCursor = resolvedCursors[sourcePage - 1]!;
    const sourceData = sourcePage === currentPage
      && cursorHistory[currentPage - 1] === sourceCursor
      && currentPageData
      ? currentPageData
      : await loadWithinLimit(sourceCursor);
    signal?.throwIfAborted();
    if (!sourceData.next_cursor) {
      throw new Error("Admin image page cursor chain ended early");
    }
    resolvedCursors.push(sourceData.next_cursor);
    resolvedBoundaries += 1;
    onProgress?.({
      targetPage,
      resolvedBoundaries,
      totalBoundaries,
      loadingTarget: false
    });
  }

  signal?.throwIfAborted();
  onProgress?.({
    targetPage,
    resolvedBoundaries,
    totalBoundaries,
    loadingTarget: true
  });
  const cursor = resolvedCursors[targetPage - 1]!;
  const pageData = targetPage === currentPage
    && cursorHistory[currentPage - 1] === cursor
    && currentPageData
    ? currentPageData
    : await loadWithinLimit(cursor);
  signal?.throwIfAborted();
  return { cursorHistory: resolvedCursors, pageData };
}
