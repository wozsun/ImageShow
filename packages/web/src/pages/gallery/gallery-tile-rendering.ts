import type { GalleryImageCardDto } from "@imageshow/shared/browser";
import type { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import type { GalleryWindowPosition } from "./gallery-data-window.js";

export type GalleryTileRenderProps = {
  position: GalleryWindowPosition & { item: GalleryImageCardDto };
  revealOrder: number;
  revealRegistry: GalleryCardRevealRegistry;
  subtitle: string;
  onOpen: (
    card: GalleryImageCardDto,
    opener: HTMLButtonElement
  ) => void;
};

export function galleryTilePropsEqual(
  previous: GalleryTileRenderProps,
  current: GalleryTileRenderProps
) {
  const previousPosition = previous.position;
  const currentPosition = current.position;
  return (
    previousPosition.item === currentPosition.item &&
    previousPosition.index === currentPosition.index &&
    previousPosition.column === currentPosition.column &&
    previousPosition.x === currentPosition.x &&
    previousPosition.y === currentPosition.y &&
    previousPosition.width === currentPosition.width &&
    previousPosition.height === currentPosition.height &&
    previous.revealRegistry === current.revealRegistry &&
    previous.subtitle === current.subtitle &&
    previous.onOpen === current.onOpen
  );
}
