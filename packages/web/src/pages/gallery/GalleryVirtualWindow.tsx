import {
  memo,
  type CSSProperties,
  type RefObject
} from "react";
import { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import type { GalleryWindowPosition } from "./gallery-data-window.js";
import {
  galleryTileTags,
  galleryTileTitle,
  type GalleryTileRenderProps
} from "./gallery-tile-rendering.js";
import { GalleryTile } from "./GalleryTile.js";

type GalleryVirtualWindowProps = {
  imageQuery: string;
  onOpen: GalleryTileRenderProps["onOpen"];
  positions: readonly GalleryWindowPosition[];
  revealRegistry: GalleryCardRevealRegistry;
  tagNames: ReadonlyMap<string, string>;
  themeNames: ReadonlyMap<string, string>;
  totalHeight: number;
  windowRef: RefObject<HTMLDivElement | null>;
};

function GalleryWindowPlaceholder({
  position
}: {
  position: GalleryWindowPosition;
}) {
  return (
    <span
      className="tile gallery-virtual-placeholder"
      data-image-id={position.id}
      aria-hidden="true"
      style={{
        left: position.x,
        top: position.y,
        width: position.width,
        height: position.height
      } as CSSProperties}
    />
  );
}

export const GalleryVirtualWindow = memo(function GalleryVirtualWindow({
  imageQuery,
  onOpen,
  positions,
  revealRegistry,
  tagNames,
  themeNames,
  totalHeight,
  windowRef
}: GalleryVirtualWindowProps) {
  return (
    <div
      ref={windowRef}
      className="gallery-window"
      style={{ height: totalHeight }}
    >
      {positions.map((position, index) => position.item ? (
        <GalleryTile
          key={`${imageQuery}:${position.id}`}
          position={{ ...position, item: position.item }}
          revealOrder={index}
          revealRegistry={revealRegistry}
          title={galleryTileTitle(position.item, themeNames)}
          tags={galleryTileTags(position.item, tagNames)}
          onOpen={onOpen}
        />
      ) : (
        <GalleryWindowPlaceholder
          key={`${imageQuery}:${position.id}`}
          position={position}
        />
      ))}
    </div>
  );
});
