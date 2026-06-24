import { useEffect, useRef, useState } from "react";
import { galleryImageRatio } from "../lib/gallery-layout.js";
import { Icon } from "./Icon.js";
import type { Device } from "../lib/types.js";

export function LazyGalleryImage({ src, alt, device, width, height }: { src: string; alt: string; device: Device; width: number; height: number }) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);
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
    }, { rootMargin: "360px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);
  return (
    <div ref={holderRef} className={`tile-image-shell ${loaded ? "loaded" : ""}`} style={{ "--tile-ratio": galleryImageRatio(device, width, height) } as React.CSSProperties}>
      {active && !failed && <img src={src} alt={alt} onLoad={() => setLoaded(true)} onError={() => { setFailed(true); setLoaded(true); }} />}
      {active && failed && <span className="thumb-fallback tile-image-fallback" role="img" aria-label={alt || "图片加载失败"}><Icon name="file-damage-line" /></span>}
    </div>
  );
}
