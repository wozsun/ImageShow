import {
  memo,
  type CSSProperties,
  type RefObject
} from "react";
import { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import type { GalleryWindowPosition } from "./gallery-data-window.js";
import type { GalleryTileRenderProps } from "./gallery-tile-rendering.js";
import { GalleryTile } from "./GalleryTile.js";
import type { GalleryImageCard } from "../../lib/types.js";

type GalleryVirtualWindowProps = {
  cardSubtitle: (card: GalleryImageCard) => string;
  imageQuery: string;
  onOpen: GalleryTileRenderProps["onOpen"];
  positions: readonly GalleryWindowPosition[];
  revealRegistry: GalleryCardRevealRegistry;
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
  cardSubtitle,
  imageQuery,
  onOpen,
  positions,
  revealRegistry,
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
          subtitle={cardSubtitle(position.item)}
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
