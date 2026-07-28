import { useEffect, useRef, useState } from "react";
import { galleryLazyRootMargin } from "../../lib/constants.js";
import { Icon } from "../../components/icon/Icon.js";
import type { Device } from "../../lib/types.js";
import { galleryImageRatio } from "./gallery-layout.js";

type GalleryVisibilityListener = (visible: boolean) => void;

const galleryVisibilityListeners = new Map<Element, GalleryVisibilityListener>();
let galleryVisibilityObserver: IntersectionObserver | undefined;
let galleryVisibilityViewportHeight = 0;
let galleryVisibilityResizeFrame: number | undefined;

function currentGalleryViewportHeight() {
  return window.visualViewport?.height ?? window.innerHeight;
}

function createGalleryVisibilityObserver() {
  galleryVisibilityViewportHeight = currentGalleryViewportHeight();
  const observer = new IntersectionObserver((entries) => {
    if (galleryVisibilityObserver !== observer) return;
    for (const entry of entries) {
      galleryVisibilityListeners.get(entry.target)?.(entry.isIntersecting);
    }
  }, {
    rootMargin: galleryLazyRootMargin(galleryVisibilityViewportHeight)
  });
  galleryVisibilityObserver = observer;
  for (const target of galleryVisibilityListeners.keys()) {
    observer.observe(target);
  }
}

function updateGalleryVisibilityObserver() {
  galleryVisibilityResizeFrame = undefined;
  if (galleryVisibilityListeners.size === 0) return;
  const nextViewportHeight = currentGalleryViewportHeight();
  if (Math.abs(nextViewportHeight - galleryVisibilityViewportHeight) < 1) return;
  galleryVisibilityObserver?.disconnect();
  createGalleryVisibilityObserver();
}

function scheduleGalleryVisibilityUpdate() {
  if (galleryVisibilityResizeFrame !== undefined) return;
  galleryVisibilityResizeFrame = window.requestAnimationFrame(
    updateGalleryVisibilityObserver
  );
}

function stopGalleryVisibilityObserver() {
  const observer = galleryVisibilityObserver;
  galleryVisibilityObserver = undefined;
  observer?.disconnect();
  window.removeEventListener("resize", scheduleGalleryVisibilityUpdate);
  window.visualViewport?.removeEventListener(
    "resize",
    scheduleGalleryVisibilityUpdate
  );
  if (galleryVisibilityResizeFrame !== undefined) {
    window.cancelAnimationFrame(galleryVisibilityResizeFrame);
    galleryVisibilityResizeFrame = undefined;
  }
  galleryVisibilityViewportHeight = 0;
}

function observeGalleryVisibility(
  target: Element,
  listener: GalleryVisibilityListener
) {
  if (typeof IntersectionObserver === "undefined") {
    listener(true);
    return () => undefined;
  }

  galleryVisibilityListeners.set(target, listener);
  if (!galleryVisibilityObserver) {
    window.addEventListener("resize", scheduleGalleryVisibilityUpdate);
    window.visualViewport?.addEventListener(
      "resize",
      scheduleGalleryVisibilityUpdate
    );
    createGalleryVisibilityObserver();
  } else {
    galleryVisibilityObserver.observe(target);
  }

  return () => {
    galleryVisibilityObserver?.unobserve(target);
    galleryVisibilityListeners.delete(target);
    if (galleryVisibilityListeners.size === 0) {
      stopGalleryVisibilityObserver();
    }
  };
}

export function LazyGalleryImage({ src, alt, device, width, height, priority = false }: { src: string; alt: string; device: Device; width: number; height: number; priority?: boolean }) {
  const holderRef = useRef<HTMLDivElement | null>(null);

  const [active, setActive] = useState(priority);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const target = holderRef.current;
    if (!target) return;
    return observeGalleryVisibility(target, setActive);
  }, []);
  return (
    <div
      ref={holderRef}
      className={`tile-image-shell ${loaded ? "loaded" : ""}`}
      style={{ "--tile-ratio": galleryImageRatio(device, width, height) } as React.CSSProperties}
    >
      {active && !failed && (
        <img
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          width={width > 0 ? width : undefined}
          height={height > 0 ? height : undefined}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => { setFailed(true); setLoaded(true); }}
        />
      )}
      {active && failed && (
        <span className="thumb-fallback tile-image-fallback" role="img" aria-label={alt || "图片加载失败"}>
          <Icon name="file-damage-line" />
        </span>
      )}
    </div>
  );
}
