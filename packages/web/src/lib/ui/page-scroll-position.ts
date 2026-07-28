const pageScrollBoundaryTolerance = 4;

export type PageScrollPosition = {
  top: number;
  maximum: number;
  atBottom: boolean;
};

export function normalizePageScrollPosition(
  rawScrollTop: number,
  contentHeight: number,
  viewportHeight: number,
  boundaryTolerance = pageScrollBoundaryTolerance
): PageScrollPosition {
  const maximum = Math.max(0, contentHeight - viewportHeight);
  const top = Math.min(maximum, Math.max(0, rawScrollTop));
  return {
    top,
    maximum,
    atBottom: top >= Math.max(0, maximum - boundaryTolerance)
  };
}

export function pageScrollDelta(
  previous: PageScrollPosition,
  current: PageScrollPosition
) {
  // Safari can report scrollY beyond the document maximum during elastic
  // overscroll. Both the overshoot and the rebound normalize to the bottom
  // boundary and must not be interpreted as an upward navigation gesture.
  if (previous.atBottom && current.atBottom) return 0;
  return current.top - previous.top;
}
