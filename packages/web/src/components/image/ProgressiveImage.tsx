import { useEffect, useState, type CSSProperties, type MouseEventHandler } from "react";

export function ProgressiveImage({
  imageKey,
  thumbSrc = "",
  fullSrc = "",
  alt = "",
  className = "",
  loading = "eager",
  onClick,
  style
}: {
  imageKey: string;
  thumbSrc?: string;
  fullSrc?: string;
  alt?: string;
  className?: string;
  loading?: "eager" | "lazy";
  onClick?: MouseEventHandler<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const fallbackSrc = thumbSrc || fullSrc;
  const [loadedFullSrc, setLoadedFullSrc] = useState(() => fullSrc && fullSrc === fallbackSrc ? fullSrc : "");

  useEffect(() => {
    let cancelled = false;
    setLoadedFullSrc(fullSrc && fullSrc === fallbackSrc ? fullSrc : "");
    if (!fullSrc || fullSrc === fallbackSrc) return () => {
      cancelled = true;
    };

    const image = new Image();
    image.referrerPolicy = "no-referrer";
    const finish = () => {
      if (!cancelled) setLoadedFullSrc(fullSrc);
    };
    image.onload = () => {
      if (typeof image.decode === "function") void image.decode().then(finish, finish);
      else finish();
    };
    image.onerror = () => {
      if (!cancelled) setLoadedFullSrc("");
    };
    image.src = fullSrc;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
      image.src = "";
    };
  }, [imageKey, fallbackSrc, fullSrc]);

  const hasFullOverlay = Boolean(loadedFullSrc && loadedFullSrc !== fallbackSrc);
  const stateClass = hasFullOverlay ? "is-full" : loadedFullSrc ? "is-direct" : "is-thumb";

  return (
    <div className={`progressive-image ${className} ${stateClass}`.trim()} style={style} onClick={onClick}>
      {fallbackSrc && (
        <img
          className="progressive-image-thumb"
          src={fallbackSrc}
          alt={alt}
          loading={loading}
          decoding="async"
          referrerPolicy="no-referrer"
        />
      )}
      {loadedFullSrc && loadedFullSrc !== fallbackSrc && (
        <div className="progressive-image-full-frame" aria-hidden="true">
          <img
            className="progressive-image-full"
            src={loadedFullSrc}
            alt=""
            loading={loading}
            decoding="async"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </div>
  );
}
