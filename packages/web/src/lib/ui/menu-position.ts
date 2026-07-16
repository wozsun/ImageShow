import type { CSSProperties } from "react";

type MenuPosition = CSSProperties & { maxHeight: number };

export type AnchoredMenuPosition = {
  placement: "above" | "below";
  style: MenuPosition;
};

export type AnchoredMenuSize = {
  minWidth: number;
  maxWidth?: number;
  align?: "start" | "end";
  flipThreshold: number;
  minAvailable: number;
  maxHeight: number;
};

export function computeAnchoredPosition(
  rect: DOMRect,
  size: AnchoredMenuSize,
  naturalMenuHeight = size.maxHeight
): AnchoredMenuPosition {
  const gap = 6;
  // DOMRect 的 top/left 可直接用于 fixed 的 top/left；visualViewport 的 offset
  // 只用于建立当前真正可见的边界，不能再次叠加到锚点坐标。这样软键盘平移
  // 视觉视口后，上下可用高度和左右夹取范围都会同步更新。
  const visualViewport = window.visualViewport;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
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
