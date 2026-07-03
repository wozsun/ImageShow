import { useEffect, useRef, useState } from "react";
import { galleryLazyRootMargin } from "../../lib/constants.js";
import { galleryImageRatio } from "../../lib/gallery/gallery-layout.js";
import { Icon } from "../icon/Icon.js";
import type { Device } from "../../lib/types.js";

export function LazyGalleryImage({ src, alt, device, width, height, priority = false }: { src: string; alt: string; device: Device; width: number; height: number; priority?: boolean }) {
  const holderRef = useRef<HTMLDivElement | null>(null);

  const [active, setActive] = useState(priority);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (active) return;
    const target = holderRef.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setActive(true);
        observer.disconnect();
      }
    }, { rootMargin: galleryLazyRootMargin });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);
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
