import {
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject
} from "react";
import {
  galleryMaxMountedTiles,
  galleryVirtualOverscanScreens
} from "../../lib/constants.js";
import type { Device } from "../../lib/types.js";
import {
  isPageScrollLocked,
  pageScrollRestoredEvent
} from "../../hooks/usePageScrollLock.js";
import { galleryColumnCount } from "./gallery-columns.js";
import {
  masonryWindow,
  type GalleryGeometry,
  type MasonryLayout
} from "./masonry-layout.js";

export {
  computeMasonryLayout
} from "./masonry-layout.js";
export type {
  MasonryItemPosition
} from "./masonry-layout.js";

export function useGalleryColumnCount() {
  const [columnCount, setColumnCount] = useState(
    () => galleryColumnCount(window.innerWidth)
  );
  useEffect(() => {
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      setColumnCount(galleryColumnCount(window.innerWidth));
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);
  return columnCount;
}

function cssPixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function useGalleryGeometry(
  galleryRef: RefObject<HTMLElement | null>
) {
  const [geometry, setGeometry] = useState<GalleryGeometry>(() => {
    const mobile = window.innerWidth <= 760;
    const padding = mobile ? 16 : 28;
    return {
      contentWidth: Math.max(0, window.innerWidth - padding * 2),
      gap: mobile ? 12 : 16
    };
  });

  useLayoutEffect(() => {
    const gallery = galleryRef.current;
    if (!gallery) return;
    const update = () => {
      const style = window.getComputedStyle(gallery);
      const contentWidth = Math.max(
        0,
        gallery.clientWidth
        - cssPixels(style.paddingLeft)
        - cssPixels(style.paddingRight)
      );
      const gap = cssPixels(
        style.getPropertyValue("--gallery-gap")
      );
      setGeometry((current) => (
        Math.abs(current.contentWidth - contentWidth) < 0.5
        && Math.abs(current.gap - gap) < 0.5
      ) ? current : { contentWidth, gap });
    };
    const observer = new ResizeObserver(update);
    observer.observe(gallery);
    update();
    return () => observer.disconnect();
  }, [galleryRef]);

  return geometry;
}

export function useMasonryWindow(
  windowRef: RefObject<HTMLElement | null>,
  layout: MasonryLayout,
  pinnedItemId: string | null = null
) {
  const [range, setRange] = useState(() => ({
    start: 0,
    end: window.innerHeight * (1 + galleryVirtualOverscanScreens),
    visibleStart: 0,
    visibleEnd: window.innerHeight
  }));

  useLayoutEffect(() => {
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      if (isPageScrollLocked()) return;
      const element = windowRef.current;
      if (!element) return;
      const viewportHeight = Math.max(1, window.innerHeight);
      const visibleStart = Math.max(0, -element.getBoundingClientRect().top);
      const overscan = viewportHeight * galleryVirtualOverscanScreens;
      const next = {
        start: Math.max(0, visibleStart - overscan),
        end: Math.min(
          layout.totalHeight,
          visibleStart + viewportHeight + overscan
        ),
        visibleStart,
        visibleEnd: visibleStart + viewportHeight
      };
      setRange((current) => (
        Math.abs(current.start - next.start) < 1
        && Math.abs(current.end - next.end) < 1
        && Math.abs(current.visibleStart - next.visibleStart) < 1
        && Math.abs(current.visibleEnd - next.visibleEnd) < 1
      ) ? current : next);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener(pageScrollRestoredEvent, schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener(pageScrollRestoredEvent, schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [layout.totalHeight, windowRef]);

  return masonryWindow(
    layout.positions,
    range.start,
    range.end,
    galleryMaxMountedTiles,
    range.visibleStart,
    range.visibleEnd,
    pinnedItemId
  );
}

export function galleryImageRatio(
  device: Device,
  width = 0,
  height = 0
) {
  if (width > 0 && height > 0) return `${width} / ${height}`;
  if (device === "mb") return "9 / 16";
  if (device === "pc") return "16 / 9";
  return "1 / 1";
}
