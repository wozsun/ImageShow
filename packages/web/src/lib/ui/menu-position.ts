import type { CSSProperties } from "react";

type MenuPosition = CSSProperties & { maxHeight: number };

export type FixedPositionOrigin = {
  left: number;
  top: number;
};

export type AnchoredMenuPosition = {
  placement: "above" | "below";
  style: MenuPosition;
};

export type AnchoredMenuSize = {
  minWidth: number;
  maxWidth?: number;
  align?: "start" | "end";
  gap?: number;
  flipThreshold: number;
  minAvailable: number;
  maxHeight: number;
};

const defaultFixedPositionOrigin: FixedPositionOrigin = { left: 0, top: 0 };
const fixedOriginProbeSelector = "[data-anchored-fixed-origin]";

export function measureFixedPositionOrigin(): FixedPositionOrigin {
  if (typeof document === "undefined" || !document.body) {
    return defaultFixedPositionOrigin;
  }

  let probe = document.querySelector<HTMLElement>(fixedOriginProbeSelector);
  const temporary = !probe;
  if (!probe) {
    probe = document.createElement("span");
    probe.setAttribute("data-anchored-fixed-origin", "");
    probe.setAttribute("aria-hidden", "true");
    Object.assign(probe.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      margin: "0",
      padding: "0",
      border: "0",
      visibility: "hidden",
      pointerEvents: "none"
    });
    document.body.append(probe);
  }

  try {
    const rect = probe.getBoundingClientRect();
    return {
      left: Number.isFinite(rect.left) ? rect.left : 0,
      top: Number.isFinite(rect.top) ? rect.top : 0
    };
  } finally {
    if (temporary) probe.remove();
  }
}

export function fixedPositionFromViewport(
  style: CSSProperties,
  fixedOrigin: FixedPositionOrigin
): CSSProperties {
  // iOS may pan the document while the software keyboard is visible, so a
  // fixed element declared at top/left 0 can paint away from viewport 0/0.
  // Subtract its observed origin to map the desired viewport coordinates back
  // into the CSS offsets consumed by the same fixed positioning context.
  return {
    ...style,
    left: typeof style.left === "number"
      ? style.left - fixedOrigin.left
      : style.left,
    top: typeof style.top === "number"
      ? style.top - fixedOrigin.top
      : style.top
  };
}

export function localizeAnchoredPosition(
  style: CSSProperties,
  origin: {
    left: number;
    top: number;
    scrollLeft?: number;
    scrollTop?: number;
  }
): CSSProperties {
  return {
    ...style,
    position: "absolute",
    left: typeof style.left === "number"
      ? style.left - origin.left + (origin.scrollLeft ?? 0)
      : style.left,
    top: typeof style.top === "number"
      ? style.top - origin.top + (origin.scrollTop ?? 0)
      : style.top
  };
}

export function computeAnchoredPosition(
  rect: DOMRect,
  size: AnchoredMenuSize,
  naturalMenuHeight = size.maxHeight,
  fixedOrigin = defaultFixedPositionOrigin
): AnchoredMenuPosition {
  const gap = size.gap ?? 6;
  const visualViewport = window.visualViewport;
  // visualViewport 的 offset 使用 fixed/layout 坐标，而锚点 DOMRect 使用
  // 浏览器实际绘制坐标。加上实测 fixed 原点后，可见边界、锚点和最终菜单
  // 都在同一坐标系中参与翻转、高度与左右夹取。
  const viewportTop = (visualViewport?.offsetTop ?? 0) + fixedOrigin.top;
  const viewportLeft = (visualViewport?.offsetLeft ?? 0) + fixedOrigin.left;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  const viewportWidth = visualViewport?.width ?? window.innerWidth;
  const viewportBottom = viewportTop + viewportHeight;
  const viewportRight = viewportLeft + viewportWidth;
  const availableBelow = Math.max(0, viewportBottom - rect.bottom - gap - 8);
  const availableAbove = Math.max(0, rect.top - viewportTop - gap - 8);
  const openAbove = availableBelow < Math.max(size.flipThreshold, size.minAvailable)
    && availableAbove > availableBelow;
  const available = openAbove ? availableAbove : availableBelow;
  const maxHeight = Math.min(size.maxHeight, available);
  const renderedMenuHeight = Math.min(
    maxHeight,
    Number.isFinite(naturalMenuHeight) ? Math.max(0, naturalMenuHeight) : size.maxHeight
  );
  const desiredWidth = Math.min(size.maxWidth ?? Number.POSITIVE_INFINITY, Math.max(size.minWidth, rect.width));
  const width = Math.min(desiredWidth, Math.max(0, viewportWidth - 16));
  const desiredLeft = size.align === "end" ? rect.right - width : rect.left;
  return {
    placement: openAbove ? "above" : "below",
    style: {
      left: Math.max(viewportLeft + 8, Math.min(desiredLeft, viewportRight - width - 8)),
      width,
      maxHeight,
      // top 与 getBoundingClientRect() 使用同一坐标系。不要用 bottom 反推位置：
      // iOS 软键盘出现时，fixed 的底边和 window.innerHeight 可能对应不同视口。
      top: openAbove ? rect.top - gap - renderedMenuHeight : rect.bottom + gap,
      bottom: "auto"
    }
  };
}
