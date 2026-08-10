import type { GalleryImageCard } from "../../lib/types.js";
import { imageDisplayTitle } from "../../lib/ui/formatters.js";
import type { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import type { GalleryWindowPosition } from "./gallery-data-window.js";

export type GalleryTileRenderProps = {
  position: GalleryWindowPosition & { item: GalleryImageCard };
  revealOrder: number;
  revealRegistry: GalleryCardRevealRegistry;
  title: string;
  tags: string;
  onOpen: (
    card: GalleryImageCard,
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
    previousPosition.item === currentPosition.item
    && previousPosition.index === currentPosition.index
    && previousPosition.column === currentPosition.column
    && previousPosition.x === currentPosition.x
    && previousPosition.y === currentPosition.y
    && previousPosition.width === currentPosition.width
    && previousPosition.height === currentPosition.height
    && previous.revealRegistry === current.revealRegistry
    && previous.title === current.title
    && previous.tags === current.tags
    && previous.onOpen === current.onOpen
  );
}

export function galleryTileTitle(
  item: GalleryImageCard,
  themeNames: ReadonlyMap<string, string>
) {
  const themeLabel = item.theme === "none"
    ? ""
    : themeNames.get(item.theme) ?? item.theme;
  return item.title?.trim() || themeLabel || imageDisplayTitle(item);
}

export function galleryTileTags(
  item: GalleryImageCard,
  tagNames: ReadonlyMap<string, string>
) {
  return item.tags
    .map((tag) => tagNames.get(tag) ?? tag)
    .join(" · ");
}
