const tagScrollEpsilon = 1;
const tagWheelHorizontalEpsilon = 0.01;

export type TagScrollMetrics = {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
};

export type TagScrollItemMetrics = {
  offsetLeft: number;
  offsetWidth: number;
};

export type TagScrollNavigationInsets = {
  leading: number;
  trailing: number;
};

export function tagScrollContentMetrics(
  metrics: TagScrollMetrics,
  paddingLeft: number,
  paddingRight: number
): TagScrollMetrics {
  const horizontalPadding = Math.max(0, paddingLeft)
    + Math.max(0, paddingRight);
  const clientWidth = Math.max(0, metrics.clientWidth - horizontalPadding);
  return {
    clientWidth,
    scrollLeft: metrics.scrollLeft,
    scrollWidth: Math.max(
      clientWidth,
      metrics.scrollWidth - horizontalPadding
    )
  };
}

export function tagScrollItemMetrics(
  viewportLeft: number,
  scrollLeft: number,
  itemRect: Pick<DOMRect, "left" | "width">,
  contentInset = 0
): TagScrollItemMetrics {
  return {
    offsetLeft: itemRect.left - viewportLeft + scrollLeft - contentInset,
    offsetWidth: itemRect.width
  };
}

export type TagScrollAvailability = {
  backward: boolean;
  forward: boolean;
};

export function tagScrollAvailability({
  clientWidth,
  scrollLeft,
  scrollWidth
}: TagScrollMetrics): TagScrollAvailability {
  const maximum = Math.max(0, scrollWidth - clientWidth);
  return {
    backward: scrollLeft > tagScrollEpsilon,
    forward: scrollLeft < maximum - tagScrollEpsilon
  };
}

function clampTagScrollLeft(metrics: TagScrollMetrics, value: number) {
  return Math.min(
    Math.max(0, metrics.scrollWidth - metrics.clientWidth),
    Math.max(0, value)
  );
}

/**
 * Reveals one adjacent obscured item per activation using the smallest shift
 * that makes an ordinary item whole. An item wider than the viewport advances
 * at most one content viewport per activation, so an arbitrarily wide item
 * never loses a middle segment.
 */
export function tagScrollNavigationTarget(
  metrics: TagScrollMetrics,
  items: readonly TagScrollItemMetrics[],
  direction: -1 | 1,
  navigationInsets: TagScrollNavigationInsets = {
    leading: 0,
    trailing: 0
  }
) {
  const leadingInset = Math.min(
    metrics.clientWidth,
    Math.max(0, navigationInsets.leading)
  );
  const trailingInset = Math.min(
    Math.max(0, metrics.clientWidth - leadingInset),
    Math.max(0, navigationInsets.trailing)
  );
  // Keep one CSS pixel clear of an overlaid button. Browsers can quantize a
  // fractional scrollLeft to device pixels; exact edge alignment would then
  // leave a sub-pixel sliver rendered below the translucent gradient.
  const leadingClearance = leadingInset > 0 ? tagScrollEpsilon : 0;
  const trailingClearance = trailingInset > 0 ? tagScrollEpsilon : 0;
  const visibleWidth = Math.max(
    tagScrollEpsilon,
    metrics.clientWidth
      - leadingInset
      - trailingInset
      - leadingClearance
      - trailingClearance
  );
  const visibleStart = metrics.scrollLeft
    + leadingInset
    + leadingClearance;
  const visibleEnd = metrics.scrollLeft
    + metrics.clientWidth
    - trailingInset
    - trailingClearance;
  if (direction > 0) {
    const nextItem = items.find((item) => (
      item.offsetLeft + item.offsetWidth > visibleEnd + tagScrollEpsilon
    ));
    if (!nextItem) return clampTagScrollLeft(metrics, metrics.scrollWidth);

    const trailingTarget = nextItem.offsetLeft
      + nextItem.offsetWidth
      - metrics.clientWidth
      + trailingInset
      + trailingClearance;
    const target = nextItem.offsetWidth > visibleWidth
      ? Math.min(metrics.scrollLeft + visibleWidth, trailingTarget)
      : trailingTarget;
    return clampTagScrollLeft(
      metrics,
      target
    );
  }

  const previousItem = items.findLast((item) => (
    item.offsetLeft < visibleStart - tagScrollEpsilon
  ));
  if (!previousItem) return 0;

  const trailingTarget = previousItem.offsetLeft
    + previousItem.offsetWidth
    - metrics.clientWidth
    + trailingInset
    + trailingClearance;
  const leadingTarget = previousItem.offsetLeft
    - leadingInset
    - leadingClearance;
  const target = previousItem.offsetWidth > visibleWidth
    ? metrics.scrollLeft > trailingTarget + tagScrollEpsilon
      ? Math.max(metrics.scrollLeft - visibleWidth, trailingTarget)
      : Math.max(
          leadingTarget,
          metrics.scrollLeft - visibleWidth
        )
    : leadingTarget;
  return clampTagScrollLeft(
    metrics,
    target
  );
}

/**
 * A wheel event with any meaningful horizontal component belongs to a native
 * trackpad gesture. Pure vertical wheel input is converted into pixels for
 * the tag viewport, which owns that wheel input even at either scroll edge.
 */
export function tagVerticalWheelPixels({
  clientWidth,
  deltaMode,
  deltaX,
  deltaY
}: Pick<TagScrollMetrics, "clientWidth"> & {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
}) {
  if (Math.abs(deltaX) > tagWheelHorizontalEpsilon) return null;
  const pixels = deltaMode === 1
    ? deltaY * 16
    : deltaMode === 2
      ? deltaY * clientWidth
      : deltaY;
  return Math.abs(pixels) <= tagScrollEpsilon ? null : pixels;
}

export function tagWheelScrollTarget(
  metrics: TagScrollMetrics,
  delta: number
) {
  return clampTagScrollLeft(metrics, metrics.scrollLeft + delta);
}
