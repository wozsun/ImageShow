import type { GalleryImageCard } from "../../lib/types.js";
import { imageDisplayTitle } from "../../lib/ui/formatters.js";
import type { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import type { MasonryItemPosition } from "./masonry-layout.js";

export type GalleryTileRenderProps = {
  position: MasonryItemPosition;
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
  return (
    previous.position === current.position
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
