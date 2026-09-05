import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { Icon } from "../../components/icon/Icon.js";
import {
  clearImageElement,
  loadImageElement
} from "../../components/image/image-element-loader.js";
import {
  imageLoadPriority,
  type ImageLoadTaskHandle
} from "../../components/image/image-load-scheduler.js";
import type { Device } from "../../lib/types.js";
import { galleryImageRatio } from "./gallery-layout.js";
import {
  type GalleryImageVisibility
} from "./gallery-image-visibility.js";
import { useGalleryImageRuntime } from "./GalleryImageRuntime.js";

const hiddenVisibility: GalleryImageVisibility = {
  inViewport: false,
  inLoadRange: false,
  inResidenceRange: false
};

function GalleryImageDevelopmentStats() {
  const { debug } = useGalleryImageRuntime();
  useEffect(() => debug?.mountImg(), [debug]);
  return null;
}

function GalleryThumbnailFallbackDevelopmentStats() {
  const { debug } = useGalleryImageRuntime();
  const recordedRef = useRef(false);
  useEffect(() => {
    if (!debug || recordedRef.current) return;
    recordedRef.current = true;
    debug.recordThumbnailFallback();
  }, [debug]);
  return null;
}

export const LazyGalleryImage = memo(function LazyGalleryImage({
  src,
  alt,
  device,
  width,
  height
}: {
  src: string;
  alt: string;
  device: Device;
  width: number;
  height: number;
}) {
  const {
    scheduler,
    visibility: visibilityController,
    galleryPaused
  } =
    useGalleryImageRuntime();
  const holderRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const taskRef = useRef<ImageLoadTaskHandle | null>(null);
  const inViewportRef = useRef(false);
  const [visibility, setVisibility] =
    useState<GalleryImageVisibility>(hiddenVisibility);
  const [renderImage, setRenderImage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  inViewportRef.current = visibility.inViewport;
  const setImageRef = useCallback((image: HTMLImageElement | null) => {
    imageRef.current = image;
  }, []);

  useEffect(() => {
    const target = holderRef.current;
    if (!target) return;
    return visibilityController.observe(target, setVisibility);
  }, [visibilityController]);

  useEffect(() => {
    taskRef.current?.reprioritize(
      visibility.inViewport
        ? imageLoadPriority.viewport
        : imageLoadPriority.nearby
    );
    if (galleryPaused) {
      if (!loaded) {
        taskRef.current?.cancel();
        if (imageRef.current) clearImageElement(imageRef.current);
        setRenderImage(false);
      }
      return;
    }
    if (!visibility.inResidenceRange) {
      taskRef.current?.cancel();
      if (imageRef.current) clearImageElement(imageRef.current);
      setRenderImage(false);
      setLoaded(false);
      setFailed(false);
      return;
    }
    if (visibility.inLoadRange && !failed) {
      setRenderImage(true);
      return;
    }
    if (
      !visibility.inLoadRange
      && !loaded
      && taskRef.current?.cancelPending()
    ) {
      setRenderImage(false);
    }
  }, [failed, galleryPaused, loaded, visibility]);

  useLayoutEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  useLayoutEffect(() => {
    if (!renderImage || failed) return;
    const image = imageRef.current;
    if (!image) return;
    let current = true;
    const task = scheduler.schedule({
      group: "gallery",
      priority: inViewportRef.current
        ? imageLoadPriority.viewport
        : imageLoadPriority.nearby,
      run: (signal) => loadImageElement(image, { src }, signal).then(
        () => undefined
      )
    });
    taskRef.current = task;
    void task.result.then((result) => {
      if (!current || taskRef.current !== task) return;
      if (result.status === "completed") {
        setLoaded(true);
      } else if (result.status === "failed") {
        setFailed(true);
        setLoaded(true);
      }
    });
    return () => {
      current = false;
      task.cancel();
      clearImageElement(image);
      if (taskRef.current === task) taskRef.current = null;
    };
  }, [
    failed,
    renderImage,
    scheduler,
    src
  ]);

  return (
    <div
      ref={holderRef}
      className={`tile-image-shell ${loaded ? "loaded" : ""}`}
      style={{
        "--tile-ratio": galleryImageRatio(device, width, height)
      } as CSSProperties}
    >
      {import.meta.env?.DEV === true && renderImage && !failed && (
        <GalleryImageDevelopmentStats />
      )}
      {import.meta.env?.DEV === true && failed && (
        <GalleryThumbnailFallbackDevelopmentStats />
      )}
      {renderImage && !failed && (
        <img
          ref={setImageRef}
          alt={alt}
          loading="eager"
          fetchPriority={visibility.inViewport ? "high" : "auto"}
          decoding="async"
          width={width > 0 ? width : undefined}
          height={height > 0 ? height : undefined}
          referrerPolicy="no-referrer"
        />
      )}
      {failed && (
        <span
          className="thumb-fallback tile-image-fallback"
          role="img"
          aria-label={alt || "图片加载失败"}
        >
          <Icon name="file-damage-line" />
        </span>
      )}
    </div>
  );
});
