import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler
} from "react";
import { useImageLoadScheduler } from "./ImageLoadSchedulerContext.js";
import {
  clearImageElement,
  loadImageElement,
  type ImageElementLoadResult
} from "./image-element-loader.js";
import {
  imageLoadPriority,
  type ImageLoadTaskHandle
} from "./image-load-scheduler.js";

export function ProgressiveImage({
  imageKey,
  thumbSrc = "",
  fullSrc = "",
  alt = "",
  className = "",
  onClick,
  style
}: {
  imageKey: string;
  thumbSrc?: string;
  fullSrc?: string;
  alt?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const scheduler = useImageLoadScheduler();
  const hasSeparateThumb = Boolean(
    thumbSrc
    && fullSrc
    && thumbSrc !== fullSrc
  );
  const fullImageRef = useRef<HTMLImageElement | null>(null);
  const fullFrameRef = useRef<HTMLDivElement | null>(null);
  const fullTaskRef = useRef<ImageLoadTaskHandle | null>(null);
  const thumbTaskRef = useRef<ImageLoadTaskHandle | null>(null);
  const [fullReady, setFullReady] = useState(false);
  const [thumbVisible, setThumbVisible] = useState(Boolean(thumbSrc));
  const [thumbFailed, setThumbFailed] = useState(false);
  const [decodeResult, setDecodeResult] =
    useState<ImageElementLoadResult | null>(null);
  const thumbRendered = Boolean(
    thumbSrc
    && thumbSrc !== fullSrc
    && thumbVisible
    && !thumbFailed
  );
  const thumbRef = useRef<HTMLImageElement | null>(null);
  const setFullImageRef = useCallback((image: HTMLImageElement | null) => {
    fullImageRef.current = image;
  }, []);
  const setThumbRef = useCallback((image: HTMLImageElement | null) => {
    thumbRef.current = image;
  }, []);

  useLayoutEffect(() => {
    setThumbVisible(Boolean(thumbSrc && thumbSrc !== fullSrc));
    setThumbFailed(false);
  }, [fullSrc, imageKey, thumbSrc]);

  useLayoutEffect(() => {
    const image = fullImageRef.current;
    setFullReady(false);
    setDecodeResult(null);
    if (!image || !fullSrc) return;

    let current = true;
    const task = scheduler.schedule({
      group: "detail",
      priority: imageLoadPriority.detailOriginal,
      run: async (signal) => {
        const result = await loadImageElement(
          image,
          { src: fullSrc },
          signal
        );
        if (current) setDecodeResult(result);
      }
    });
    fullTaskRef.current = task;
    void task.result.then((result) => {
      if (!current || fullTaskRef.current !== task) return;
      if (result.status === "completed") setFullReady(true);
    });

    return () => {
      current = false;
      task.cancel();
      clearImageElement(image);
      if (fullTaskRef.current === task) fullTaskRef.current = null;
    };
  }, [fullSrc, imageKey, scheduler]);

  useLayoutEffect(() => {
    if (!thumbRendered) return;
    const image = thumbRef.current;
    if (!image) return;
    let current = true;
    const task = scheduler.schedule({
      group: "detail",
      priority: imageLoadPriority.detailPlaceholder,
      run: (signal) => loadImageElement(
        image,
        { src: thumbSrc },
        signal
      ).then(() => undefined)
    });
    thumbTaskRef.current = task;
    void task.result.then((result) => {
      if (!current || thumbTaskRef.current !== task) return;
      if (result.status === "failed") setThumbFailed(true);
    });
    return () => {
      current = false;
      task.cancel();
      clearImageElement(image);
      if (thumbTaskRef.current === task) thumbTaskRef.current = null;
    };
  }, [imageKey, scheduler, thumbRendered, thumbSrc]);

  useEffect(() => {
    if (!fullReady || !hasSeparateThumb || !thumbVisible) return;
    const frame = fullFrameRef.current;
    if (!frame) return;
    let cancelled = false;
    let frameId: number | undefined;
    const finish = () => {
      if (!cancelled) setThumbVisible(false);
    };
    frameId = window.requestAnimationFrame(() => {
      frameId = undefined;
      const animations = typeof frame.getAnimations === "function"
        ? frame.getAnimations()
        : [];
      if (!animations.length) {
        finish();
        return;
      }
      void Promise.allSettled(
        animations.map((animation) => animation.finished)
      ).then(finish);
    });
    return () => {
      cancelled = true;
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
    };
  }, [fullReady, hasSeparateThumb, thumbVisible]);

  const stateClass = fullReady
    ? hasSeparateThumb ? "is-full" : "is-direct"
    : hasSeparateThumb ? "is-thumb" : "is-loading";

  return (
    <div
      className={`progressive-image ${className} ${stateClass}`.trim()}
      style={style}
      onClick={onClick}
    >
      {thumbRendered && (
        <img
          ref={setThumbRef}
          className="progressive-image-thumb"
          alt={fullSrc ? "" : alt}
          aria-hidden={fullSrc ? "true" : undefined}
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      )}
      {fullSrc && (
        <div
          ref={fullFrameRef}
          className={`progressive-image-full-frame${fullReady ? " is-ready" : ""}`}
          onAnimationEnd={() => {
            if (fullReady && hasSeparateThumb) setThumbVisible(false);
          }}
        >
          <img
            ref={setFullImageRef}
            className="progressive-image-full"
            alt={alt}
            loading="eager"
            decoding="async"
            referrerPolicy="no-referrer"
            data-image-role="full"
            data-image-decode-attempted={
              decodeResult ? String(decodeResult.decodeAttempted) : undefined
            }
            data-image-decoded={
              decodeResult ? String(decodeResult.decoded) : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
