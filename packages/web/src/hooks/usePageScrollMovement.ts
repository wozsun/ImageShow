import { useLayoutEffect, useRef } from "react";
import {
  normalizePageScrollPosition,
  pageScrollDelta,
  type PageScrollPosition
} from "../lib/ui/page-scroll-position.js";
import { getPageScrollY, isPageScrollLocked } from "./usePageScrollLock.js";

export type PageScrollMovement = {
  delta: number;
  position: PageScrollPosition;
};

function currentPageScrollPosition() {
  const contentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0
  );
  return normalizePageScrollPosition(
    getPageScrollY(),
    contentHeight,
    window.innerHeight
  );
}

export function usePageScrollMovement(
  onMovement: (movement: PageScrollMovement) => void,
  enabled = true
) {
  const onMovementRef = useRef(onMovement);

  useLayoutEffect(() => {
    onMovementRef.current = onMovement;
  }, [onMovement]);

  useLayoutEffect(() => {
    if (!enabled) return;
    let previousPosition = currentPageScrollPosition();
    let frame: number | undefined;

    const update = () => {
      frame = undefined;
      if (isPageScrollLocked()) return;
      const position = currentPageScrollPosition();
      const delta = pageScrollDelta(previousPosition, position);
      previousPosition = position;
      onMovementRef.current({ delta, position });
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    return () => {
      window.removeEventListener("scroll", scheduleUpdate);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);
}
