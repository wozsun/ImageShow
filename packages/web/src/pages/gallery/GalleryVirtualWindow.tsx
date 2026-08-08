import {
  memo,
  type RefObject
} from "react";
import { useMasonryWindow } from "./gallery-layout.js";
import { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import type { GalleryPagePreloadRange } from "./gallery-page-preload.js";
import type { MasonryLayout } from "./masonry-layout.js";
import {
  galleryTileTags,
  galleryTileTitle,
  type GalleryTileRenderProps
} from "./gallery-tile-rendering.js";
import { GalleryTile } from "./GalleryTile.js";

type GalleryVirtualWindowProps = {
  imageQuery: string;
  layout: MasonryLayout;
  nextPageRequestKey: string;
  onOpen: GalleryTileRenderProps["onOpen"];
  pagePreloadRange: GalleryPagePreloadRange | null;
  pagePreloadRef: RefObject<HTMLSpanElement | null>;
  pinnedItemId: string | null;
  revealRegistry: GalleryCardRevealRegistry;
  tagNames: ReadonlyMap<string, string>;
  themeNames: ReadonlyMap<string, string>;
  windowRef: RefObject<HTMLDivElement | null>;
};

export const GalleryVirtualWindow = memo(function GalleryVirtualWindow({
  imageQuery,
  layout,
  nextPageRequestKey,
  onOpen,
  pagePreloadRange,
  pagePreloadRef,
  pinnedItemId,
  revealRegistry,
  tagNames,
  themeNames,
  windowRef
}: GalleryVirtualWindowProps) {
  const mountedPositions = useMasonryWindow(
    windowRef,
    layout,
    pinnedItemId
  );
  return (
    <div
      ref={windowRef}
      className="gallery-window"
      style={{ height: layout.totalHeight }}
    >
      {mountedPositions.map((position, index) => (
        <GalleryTile
          key={`${imageQuery}:${position.item.id}`}
          position={position}
          revealOrder={index}
          revealRegistry={revealRegistry}
          title={galleryTileTitle(position.item, themeNames)}
          tags={galleryTileTags(position.item, tagNames)}
          onOpen={onOpen}
        />
      ))}
      {pagePreloadRange && nextPageRequestKey && (
        <span
          ref={pagePreloadRef}
          aria-hidden="true"
          data-gallery-page-preload=""
          style={{
            position: "absolute",
            top: pagePreloadRange.top,
            left: 0,
            width: 1,
            height: pagePreloadRange.height,
            pointerEvents: "none"
          }}
        />
      )}
    </div>
  );
});
