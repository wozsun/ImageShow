import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties
} from "react";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import { imageDisplayTitle } from "../../lib/ui/formatters.js";
import {
  galleryTilePropsEqual,
  type GalleryTileRenderProps
} from "./gallery-tile-rendering.js";
import { useGalleryImageRuntime } from "./GalleryImageRuntime.js";
import { LazyGalleryImage } from "./LazyGalleryImage.js";

function GalleryTileDevelopmentStats({ imageIndex }: { imageIndex: number }) {
  const { debug } = useGalleryImageRuntime();
  useEffect(() => {
    debug?.recordReveal(imageIndex);
    return debug?.mountTile();
  }, [debug, imageIndex]);
  return null;
}

export const GalleryTile = memo(function GalleryTile({
  position,
  revealOrder,
  revealRegistry,
  subtitle,
  onOpen
}: GalleryTileRenderProps) {
  const { item } = position;
  const title = imageDisplayTitle(item);
  // revealOrder is deliberately mount-only. An existing tile keeps the reveal
  // selected by this initializer when earlier cards leave the virtual window.
  const [reveal] = useState(() => revealRegistry.prepare(position.index, {
    initialViewport: position.y < window.innerHeight,
    order: revealOrder,
    reduceMotion: window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches === true
  }));
  const entrance = useOneShotAnimation(reveal.variant !== "settled");
  useLayoutEffect(() => {
    revealRegistry.markRevealed(position.index);
  }, [position.index, revealRegistry]);
  return (
    <button
      className={[
        "tile",
        "gallery-virtual-tile",
        !entrance.active
          ? ""
          : `is-gallery-card-reveal-${reveal.variant}`
      ].filter(Boolean).join(" ")}
      style={{
        left: position.x,
        top: position.y,
        width: position.width,
        height: position.height,
        "--gallery-card-reveal-delay": `${reveal.delayMs}ms`
      } as CSSProperties}
      data-image-id={item.id}
      onClick={(event) => onOpen(item, event.currentTarget)}
      onAnimationEnd={(event) => {
        if (
          event.currentTarget === event.target
          && event.animationName.startsWith("gallery-card-reveal-")
        ) {
          entrance.finish();
        }
      }}
    >
      {import.meta.env?.DEV === true && (
        <GalleryTileDevelopmentStats imageIndex={position.index} />
      )}
      <LazyGalleryImage
        src={item.thumb_url}
        alt={title}
        device={item.device}
        width={item.width}
        height={item.height}
      />
      <span className="tile-info">
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
    </button>
  );
}, galleryTilePropsEqual);
