import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icon/Icon.js";
import {
  clearImageElement,
  loadImageElement
} from "./image-element-loader.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 600;

type ThumbLoadState = {
  src: string;
  attempt: number;
  status: "loading" | "ready" | "failed";
};

function initialLoadState(src: string): ThumbLoadState {
  return { src, attempt: 0, status: "loading" };
}

export function ThumbImage({ src, alt = "", className = "" }: { src: string; alt?: string; className?: string }) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [loadState, setLoadState] = useState<ThumbLoadState>(
    () => initialLoadState(src)
  );
  const currentState = loadState.src === src
    ? loadState
    : initialLoadState(src);

  useLayoutEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;

    if (loadState.src !== src) {
      if (imageRef.current) clearImageElement(imageRef.current);
      setLoadState(initialLoadState(src));
      return;
    }

    const image = imageRef.current;
    if (!image) return;
    const attempt = loadState.attempt;
    const controller = new AbortController();
    const resolvedSrc = attempt === 0
      ? src
      : `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}`;

    void loadImageElement(
      image,
      { src: resolvedSrc, loading: "lazy" },
      controller.signal
    ).then(
      () => {
        setLoadState((current) => (
          current.src === src && current.attempt === attempt
            ? { ...current, status: "ready" }
            : current
        ));
      },
      () => {
        if (controller.signal.aborted) return;
        if (attempt >= MAX_RETRIES) {
          setLoadState((current) => (
            current.src === src && current.attempt === attempt
              ? { ...current, status: "failed" }
              : current
          ));
          return;
        }
        timer.current = window.setTimeout(() => {
          setLoadState((current) => (
            current.src === src && current.attempt === attempt
              ? { ...current, attempt: attempt + 1 }
              : current
          ));
        }, RETRY_DELAY_MS * (attempt + 1));
      }
    );

    return () => {
      controller.abort();
      window.clearTimeout(timer.current);
      timer.current = undefined;
      clearImageElement(image);
    };
  }, [loadState.attempt, loadState.src, src]);

  if (currentState.status === "failed") {
    return (
      <span className={`thumb-fallback ${className}`.trim()} role="img" aria-label={alt || "缩略图加载失败"}>
        <Icon name="file-damage-line" />
      </span>
    );
  }

  return (
    <img
      ref={imageRef}
      alt={alt}
      className={`thumb-image ${currentState.status === "ready" ? "is-ready" : ""} ${className}`.trim()}
      aria-hidden={currentState.status === "ready" ? undefined : "true"}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}
