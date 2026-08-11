import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icon/Icon.js";
import {
  loadImageElement
} from "./image-element-loader.js";

type ThumbLoadState = {
  requestedSrc: string;
  visibleSrc: string;
  status: "loading" | "ready" | "failed";
};

function initialLoadState(src: string): ThumbLoadState {
  return {
    requestedSrc: src,
    visibleSrc: "",
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
  const currentSrcRef = useRef(src);
  const [state, setState] = useState<ThumbLoadState>(
    () => initialLoadState(src)
  );

  useLayoutEffect(() => {
    currentSrcRef.current = src;
    setState((current) => {
      if (!src) {
        if (retainLoadedWhenEmpty) {
          return current.requestedSrc === "" && current.status === "ready"
            ? current
            : {
                ...current,
                requestedSrc: "",
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
        status: current.visibleSrc === src ? "ready" : "loading"
      };
    });
  }, [retainLoadedWhenEmpty, src]);

  const shouldLoad = Boolean(
    state.requestedSrc
    && state.requestedSrc === src
    && state.requestedSrc !== state.visibleSrc
    && state.status === "loading"
  );

  useLayoutEffect(() => {
    if (!shouldLoad) return;

    const image = pendingImageRef.current;
    if (!image) return;
    const loadingSrc = state.requestedSrc;
    const controller = new AbortController();

    // StrictMode replays layout effects before the first microtask. Deferring
    // the request lets the replayed cleanup cancel its setup without issuing
    // a duplicate request for the same address.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void loadImageElement(
        image,
        { src: loadingSrc, loading: "lazy" },
        controller.signal
      ).then(
        () => {
          if (currentSrcRef.current !== loadingSrc) return;
          setState((current) => (
            current.requestedSrc === loadingSrc
              ? {
                  ...current,
                  visibleSrc: loadingSrc,
                  status: "ready"
                }
              : current
          ));
        },
        () => {
          if (
            controller.signal.aborted
            || currentSrcRef.current !== loadingSrc
          ) return;
          setState((current) => (
            current.requestedSrc === loadingSrc
              ? { ...current, visibleSrc: "", status: "failed" }
              : current
          ));
        }
      );
    });

    return () => {
      controller.abort();
    };
  }, [shouldLoad, state.requestedSrc]);

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
