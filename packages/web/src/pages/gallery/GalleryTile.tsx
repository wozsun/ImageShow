import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type PointerEvent
} from "react";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import { imageDisplayTitle } from "../../lib/ui/formatters.js";
import {
  applyPointerMagnet,
  resetPointerMagnet
} from "../../lib/ui/pointer-magnet.js";
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
  const portrait = item.width > 0 && item.height > 0
    ? item.height > item.width
    : item.device === "mb";
  useLayoutEffect(() => {
    revealRegistry.markRevealed(position.index);
  }, [position.index, revealRegistry]);
  const applyMagnet = (event: PointerEvent<HTMLButtonElement>) => {
    applyPointerMagnet(event.currentTarget, event.currentTarget, event, {
      maximumAngleDegrees: portrait ? 3 : 5,
      maximumShadowOffsetPixels: 4,
      useLayoutDimensions: true
    });
  };
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
        "--gallery-card-hover-scale": portrait ? 1.03 : 1.05,
        "--gallery-card-reveal-delay": `${reveal.delayMs}ms`
      } as CSSProperties}
      data-image-id={item.id}
      onClick={(event) => onOpen(item, event.currentTarget)}
      onPointerCancel={(event) => resetPointerMagnet(event.currentTarget)}
      onPointerLeave={(event) => resetPointerMagnet(event.currentTarget)}
      onPointerMove={applyMagnet}
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
