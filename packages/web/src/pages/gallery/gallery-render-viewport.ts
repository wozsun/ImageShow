import {
  galleryLoadBufferScreens,
  galleryVirtualOverscanScreens
} from "../../lib/constants.js";
import type { GalleryDataWindowViewport } from "./gallery-data-window.js";

export const galleryRenderViewportHysteresisScreens = 0.5;

export function createGalleryRenderViewport(
  visibleStart: number,
  viewportHeight: number
): GalleryDataWindowViewport {
  const height = Math.max(1, viewportHeight);
  const start = Math.max(0, visibleStart);
  const overscan = height * galleryVirtualOverscanScreens;
  return {
    start: Math.max(0, start - overscan),
    end: start + height + overscan,
    visibleStart: start,
    visibleEnd: start + height,
    preloadEnd: start + height * (1 + galleryLoadBufferScreens)
  };
}

export function shouldRefreshGalleryRenderViewport(
  current: GalleryDataWindowViewport,
  visibleStart: number,
  viewportHeight: number
) {
  const height = Math.max(1, viewportHeight);
  const currentHeight = current.visibleEnd - current.visibleStart;
  return Math.abs(currentHeight - height) >= 1
    || Math.abs(Math.max(0, visibleStart) - current.visibleStart)
      >= height * galleryRenderViewportHysteresisScreens;
}
