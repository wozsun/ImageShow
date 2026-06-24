import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";

// Thumbnails are generated asynchronously after upload, so a just-uploaded image
// can briefly 404. Retry a couple of times (cache-busting the URL) before giving
// up so freshly uploaded cards fill in without a manual page refresh.
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 600;

// An <img> that retries a few times, then on persistent failure swaps to a
// "file-damage" glyph instead of the browser's default broken-image icon. The
// fallback fills the same box so the surrounding layout stays stable.
export function ThumbImage({ src, alt = "", className = "" }: { src: string; alt?: string; className?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setAttempt(0);
    setFailed(false);
    return () => window.clearTimeout(timer.current);
  }, [src]);

  if (failed) {
    return (
      <span className={`thumb-fallback ${className}`.trim()} role="img" aria-label={alt || "缩略图加载失败"}>
        <Icon name="file-damage-line" />
      </span>
    );
  }

  // Cache-bust on retries so the browser re-requests instead of reusing the
  // previously failed response. The proxy route ignores the extra query param.
  const resolvedSrc = attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;
  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (attempt >= MAX_RETRIES) { setFailed(true); return; }
        const next = attempt + 1;
        timer.current = window.setTimeout(() => setAttempt(next), RETRY_DELAY_MS * next);
      }}
    />
  );
}
