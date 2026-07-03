import { useEffect, useRef, useState } from "react";
import { Icon } from "../icon/Icon.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 600;

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

  const resolvedSrc = attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;
  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (attempt >= MAX_RETRIES) { setFailed(true); return; }
        const next = attempt + 1;
        timer.current = window.setTimeout(() => setAttempt(next), RETRY_DELAY_MS * next);
      }}
    />
  );
}
