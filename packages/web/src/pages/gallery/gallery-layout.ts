import {
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject
} from "react";
import type { Device } from "../../lib/types.js";
import { galleryColumnCount } from "./gallery-columns.js";

type GalleryGeometry = {
  contentWidth: number;
  gap: number;
};

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
