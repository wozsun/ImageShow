import { useEffect, type RefObject } from "react";

const axisLockThreshold = 4;
const scrollBoundaryTolerance = 1;

type GestureAxis = "pending" | "horizontal" | "vertical";

function currentPageScrollTop(scrollingElement: Element) {
  return Math.max(0, window.scrollY || scrollingElement.scrollTop);
}

export function useTouchScrollBoundaryHandoff(
  targetRef: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    let active = false;
    let axis: GestureAxis = "pending";
    let startX = 0;
    let startY = 0;
    let previousY = 0;

    const resetGesture = () => {
      active = false;
      axis = "pending";
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        resetGesture();
        return;
      }
      const touch = event.touches.item(0);
      if (!touch) return;
      active = true;
      axis = "pending";
      startX = touch.clientX;
      startY = touch.clientY;
      previousY = touch.clientY;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        resetGesture();
        return;
      }
      if (!active) return;
      const touch = event.touches.item(0);
      if (!touch) return;

      if (axis === "pending") {
        const travelX = Math.abs(touch.clientX - startX);
        const travelY = Math.abs(touch.clientY - startY);
        if (Math.max(travelX, travelY) < axisLockThreshold) return;
        axis = travelY > travelX ? "vertical" : "horizontal";
      }

      const deltaY = previousY - touch.clientY;
      previousY = touch.clientY;
      if (axis !== "vertical" || deltaY === 0) return;

      const innerMaxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
      const leavingTop = deltaY < 0 && target.scrollTop <= scrollBoundaryTolerance;
      const leavingBottom = deltaY > 0
        && target.scrollTop >= innerMaxScroll - scrollBoundaryTolerance;
      if (!leavingTop && !leavingBottom) return;

      const scrollingElement = document.scrollingElement ?? document.documentElement;
      const pageViewport = scrollingElement.clientHeight || window.innerHeight;
      const pageMaxScroll = Math.max(0, scrollingElement.scrollHeight - pageViewport);
      const pageScrollTop = Math.min(
        pageMaxScroll,
        currentPageScrollTop(scrollingElement)
      );
      const pageCanContinue = deltaY < 0
        ? pageScrollTop > scrollBoundaryTolerance
        : pageScrollTop < pageMaxScroll - scrollBoundaryTolerance;
      if (!pageCanContinue || !event.cancelable) return;

      // WebKit may keep a touch gesture latched to a nested scroller after it
      // reaches an edge. Consume only that otherwise-unused delta and move the
      // page directly; all movement before the edge remains browser-native.
      event.preventDefault();
      window.scrollBy({ top: deltaY, left: 0, behavior: "auto" });
    };

    target.addEventListener("touchstart", onTouchStart, { passive: true });
    target.addEventListener("touchmove", onTouchMove, { passive: false });
    target.addEventListener("touchend", resetGesture, { passive: true });
    target.addEventListener("touchcancel", resetGesture, { passive: true });

    return () => {
      target.removeEventListener("touchstart", onTouchStart);
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", resetGesture);
      target.removeEventListener("touchcancel", resetGesture);
    };
  }, [targetRef]);
}
