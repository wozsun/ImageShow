import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icon/Icon.js";
import {
  loadImageElement
} from "./image-element-loader.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 600;

type ThumbLoadState = {
  requestedSrc: string;
  visibleSrc: string;
  attempt: number;
  status: "loading" | "ready" | "failed";
};

function initialLoadState(src: string): ThumbLoadState {
  return {
    requestedSrc: src,
    visibleSrc: "",
    attempt: 0,
    status: src ? "loading" : "ready"
  };
}

export function ThumbImage({
  src,
  alt = "",
  className = "",
  retainLoadedWhenEmpty = false
}: {
  src: string;
  alt?: string;
  className?: string;
  retainLoadedWhenEmpty?: boolean;
}) {
  const pendingImageRef = useRef<HTMLImageElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [state, setState] = useState<ThumbLoadState>(
    () => initialLoadState(src)
  );

  useLayoutEffect(() => {
    setState((current) => {
      if (!src) {
        if (retainLoadedWhenEmpty) {
          return current.requestedSrc === "" && current.status === "ready"
            ? current
            : {
                ...current,
                requestedSrc: "",
                attempt: 0,
                status: "ready"
              };
        }
        return current.requestedSrc === "" && !current.visibleSrc
          ? current
          : initialLoadState("");
      }
      if (current.requestedSrc === src) return current;
      return {
        requestedSrc: src,
        visibleSrc: current.visibleSrc,
        attempt: 0,
        status: current.visibleSrc === src ? "ready" : "loading"
      };
    });
  }, [retainLoadedWhenEmpty, src]);

  const shouldLoad = Boolean(
    src
    && state.requestedSrc === src
    && state.requestedSrc !== state.visibleSrc
    && state.status === "loading"
  );

  useLayoutEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (!shouldLoad) return;

    const image = pendingImageRef.current;
    if (!image) return;
    const requestedSrc = state.requestedSrc;
    const attempt = state.attempt;
    const controller = new AbortController();
    const resolvedSrc = attempt === 0
      ? requestedSrc
      : `${requestedSrc}${requestedSrc.includes("?") ? "&" : "?"}retry=${attempt}`;

    void loadImageElement(
      image,
      { src: resolvedSrc, loading: "lazy" },
      controller.signal
    ).then(
      () => {
        setState((current) => (
          current.requestedSrc === requestedSrc && current.attempt === attempt
            ? {
                ...current,
                visibleSrc: requestedSrc,
                status: "ready"
              }
            : current
        ));
      },
      () => {
        if (controller.signal.aborted) return;
        if (attempt >= MAX_RETRIES) {
          setState((current) => (
            current.requestedSrc === requestedSrc && current.attempt === attempt
              ? { ...current, status: "failed" }
              : current
          ));
          return;
        }
        timer.current = window.setTimeout(() => {
          setState((current) => (
            current.requestedSrc === requestedSrc && current.attempt === attempt
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
    };
  }, [shouldLoad, state.attempt, state.requestedSrc]);

  if (state.status === "failed" && !state.visibleSrc) {
    return (
      <span className={`thumb-fallback ${className}`.trim()} role="img" aria-label={alt || "缩略图加载失败"}>
        <Icon name="file-damage-line" />
      </span>
    );
  }

  // 待加载节点完成 load/decode 后会沿用同一个 key 成为可见节点；此前的图层
  // 始终保留，避免地址切换期间出现空白帧。
  const layerSources = [
    state.visibleSrc,
    shouldLoad ? state.requestedSrc : ""
  ].filter(Boolean);

  return (
    <span className={`thumb-image ${state.visibleSrc ? "is-ready" : ""} ${className}`.trim()}>
      {layerSources.map((layerSrc) => {
        const visible = layerSrc === state.visibleSrc;
        return (
          <img
            key={layerSrc}
            ref={visible ? undefined : pendingImageRef}
            alt={visible ? alt : ""}
            className={`thumb-image-layer${visible ? " is-ready" : ""}`}
            aria-hidden={visible ? undefined : "true"}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        );
      })}
    </span>
  );
}
