const chipStripScrollEpsilon = 1;
const chipStripWheelHorizontalEpsilon = 0.01;

export type ChipStripScrollMetrics = {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
};

export type ChipStripScrollItemMetrics = {
  offsetLeft: number;
  offsetWidth: number;
};

export type ChipStripScrollNavigationInsets = {
  leading: number;
  trailing: number;
};

export function chipStripScrollContentMetrics(
  metrics: ChipStripScrollMetrics,
  paddingLeft: number,
  paddingRight: number
): ChipStripScrollMetrics {
  const horizontalPadding = Math.max(0, paddingLeft) + Math.max(0, paddingRight);
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

export function chipStripScrollItemMetrics(
  viewportLeft: number,
  scrollLeft: number,
  itemRect: Pick<DOMRect, "left" | "width">,
  contentInset = 0
): ChipStripScrollItemMetrics {
  return {
    offsetLeft: itemRect.left - viewportLeft + scrollLeft - contentInset,
    offsetWidth: itemRect.width
  };
}

export type ChipStripScrollAvailability = {
  backward: boolean;
  forward: boolean;
};

export function chipStripScrollAvailability({
  clientWidth,
  scrollLeft,
  scrollWidth
}: ChipStripScrollMetrics): ChipStripScrollAvailability {
  const maximum = Math.max(0, scrollWidth - clientWidth);
  return {
    backward: scrollLeft > chipStripScrollEpsilon,
    forward: scrollLeft < maximum - chipStripScrollEpsilon
  };
}

function clampChipStripScrollLeft(metrics: ChipStripScrollMetrics, value: number) {
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
export function chipStripScrollNavigationTarget(
  metrics: ChipStripScrollMetrics,
  items: readonly ChipStripScrollItemMetrics[],
  direction: -1 | 1,
  navigationInsets: ChipStripScrollNavigationInsets = {
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
  const leadingClearance = leadingInset > 0 ? chipStripScrollEpsilon : 0;
  const trailingClearance = trailingInset > 0 ? chipStripScrollEpsilon : 0;
  const visibleWidth = Math.max(
    chipStripScrollEpsilon,
    metrics.clientWidth - leadingInset - trailingInset - leadingClearance - trailingClearance
  );
  const visibleStart = metrics.scrollLeft + leadingInset + leadingClearance;
  const visibleEnd = metrics.scrollLeft + metrics.clientWidth - trailingInset - trailingClearance;
  if (direction > 0) {
    const nextItem = items.find(
      (item) => item.offsetLeft + item.offsetWidth > visibleEnd + chipStripScrollEpsilon
    );
    if (!nextItem) return clampChipStripScrollLeft(metrics, metrics.scrollWidth);

    const trailingTarget =
      nextItem.offsetLeft +
      nextItem.offsetWidth -
      metrics.clientWidth +
      trailingInset +
      trailingClearance;
    const target =
      nextItem.offsetWidth > visibleWidth
        ? Math.min(metrics.scrollLeft + visibleWidth, trailingTarget)
        : trailingTarget;
    return clampChipStripScrollLeft(
      metrics,
      target
    );
  }

  const previousItem = items.findLast((item) => item.offsetLeft < visibleStart - chipStripScrollEpsilon);
  if (!previousItem) return 0;

  const trailingTarget =
    previousItem.offsetLeft +
    previousItem.offsetWidth -
    metrics.clientWidth +
    trailingInset +
    trailingClearance;
  const leadingTarget = previousItem.offsetLeft - leadingInset - leadingClearance;
  const target =
    previousItem.offsetWidth > visibleWidth
      ? metrics.scrollLeft > trailingTarget + chipStripScrollEpsilon
        ? Math.max(metrics.scrollLeft - visibleWidth, trailingTarget)
        : Math.max(
            leadingTarget,
            metrics.scrollLeft - visibleWidth
          )
      : leadingTarget;
  return clampChipStripScrollLeft(
    metrics,
    target
  );
}

/**
 * A wheel event with any meaningful horizontal component belongs to a native
 * trackpad gesture. Pure vertical wheel input is converted into pixels for
 * the tag viewport, which owns that wheel input even at either scroll edge.
 */
export function chipStripVerticalWheelPixels({
  clientWidth,
  deltaMode,
  deltaX,
  deltaY
}: Pick<ChipStripScrollMetrics, "clientWidth"> & {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
}) {
  if (Math.abs(deltaX) > chipStripWheelHorizontalEpsilon) return null;
  const pixels = deltaMode === 1
    ? deltaY * 16
    : deltaMode === 2
      ? deltaY * clientWidth
      : deltaY;
  return Math.abs(pixels) <= chipStripScrollEpsilon ? null : pixels;
}

export function chipStripWheelScrollTarget(
  metrics: ChipStripScrollMetrics,
  delta: number
) {
  return clampChipStripScrollLeft(metrics, metrics.scrollLeft + delta);
}
