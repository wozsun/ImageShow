import type { GalleryCompactGeometry } from "./compact-masonry-layout.js";
import type { GalleryDataWindow } from "./gallery-data-window.js";
import type { ImageDataRevision } from "../../lib/api/image-data-revision.js";

export type GalleryScrollAnchor = {
  id: string;
  offset: number;
  pageLimit: number;
};

export type GalleryRestorationSession = {
  imageQuery: string;
  navigationKey: string;
  imageDataRevision: ImageDataRevision;
  geometry: GalleryCompactGeometry;
  controller: GalleryDataWindow;
  anchor: GalleryScrollAnchor;
};

let retainedSession: GalleryRestorationSession | null = null;

function geometryMatches(
  left: GalleryCompactGeometry,
  right: GalleryCompactGeometry
) {
  return left.columnCount === right.columnCount
    && Math.abs(left.contentWidth - right.contentWidth) < 0.5
    && Math.abs(left.gap - right.gap) < 0.5;
}

// Read during render without consuming the session so React Strict Mode's
// double render sees the same controller. The committed owner clears it.
export function reusableGalleryRestorationSession(
  imageQuery: string,
  navigationKey: string,
  geometry?: GalleryCompactGeometry
) {
  return retainedSession?.imageQuery === imageQuery
    && retainedSession.navigationKey === navigationKey
    && (!geometry || geometryMatches(retainedSession.geometry, geometry))
    ? retainedSession
    : null;
}

export function activateGalleryRestorationSession() {
  retainedSession = null;
}

export function retainGalleryRestorationSession(
  session: GalleryRestorationSession
) {
  retainedSession = session;
}
