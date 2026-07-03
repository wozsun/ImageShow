import type { CSSProperties } from "react";

export type MenuPosition = CSSProperties & { maxHeight: number };

export type AnchoredMenuSize = {
  minWidth: number;
  maxWidth?: number;
  flipThreshold: number;
  minAvailable: number;
  maxHeight: number;
};

export function computeAnchoredPosition(rect: DOMRect, size: AnchoredMenuSize): MenuPosition {
  const gap = 6;
  const availableBelow = window.innerHeight - rect.bottom - gap - 8;
  const availableAbove = rect.top - gap - 8;
  const openAbove = availableBelow < size.flipThreshold && availableAbove > availableBelow;
  const available = Math.max(size.minAvailable, openAbove ? availableAbove : availableBelow);
  const width = Math.min(size.maxWidth ?? Number.POSITIVE_INFINITY, Math.max(size.minWidth, rect.width));
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    width,
    maxHeight: Math.min(size.maxHeight, available),
    ...(openAbove
      ? { bottom: window.innerHeight - rect.top + gap, top: "auto" }
      : { top: rect.bottom + gap, bottom: "auto" })
  };
}
