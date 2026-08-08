import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { ImageLoadSchedulerProvider } from "../../components/image/ImageLoadSchedulerContext.js";
import {
  ImageLoadScheduler,
  preferredImageLoadConcurrency
} from "../../components/image/image-load-scheduler.js";
import {
  GalleryDebugStats,
  type GalleryDebugController
} from "./gallery-debug-stats.js";
import {
  GalleryImageVisibilityController,
  shouldRefreshGalleryVisibility
} from "./gallery-image-visibility.js";

type GalleryImageRuntimeValue = {
  scheduler: ImageLoadScheduler;
  visibility: GalleryImageVisibilityController;
  debug: GalleryDebugController | null;
  galleryPaused: boolean;
};

const GalleryImageRuntimeContext =
  createContext<GalleryImageRuntimeValue | null>(null);

function currentViewportHeight() {
  return Math.max(1, window.innerHeight);
}

function createRuntime(): GalleryImageRuntimeValue {
  const concurrency = window.matchMedia
    ? preferredImageLoadConcurrency(window.matchMedia.bind(window))
    : 6;
  const scheduler = new ImageLoadScheduler(concurrency);
  return {
    scheduler,
    visibility: new GalleryImageVisibilityController(currentViewportHeight()),
    debug: import.meta.env?.DEV === true
      ? new GalleryDebugStats(scheduler)
      : null,
    galleryPaused: false
  };
}

function GalleryDevelopmentStats({
  debug
}: {
  debug: GalleryDebugController;
}) {
  const snapshot = useSyncExternalStore(
    debug.subscribe,
    debug.snapshot,
    debug.snapshot
  );
  return (
    <output
      hidden
      data-gallery-debug-stats=""
      data-mounted-tiles={snapshot.mountedTiles}
      data-mounted-imgs={snapshot.mountedImgs}
      data-pending={snapshot.pending}
      data-in-flight={snapshot.inFlight}
      data-thumbnail-fallbacks={snapshot.thumbnailFallbacks}
    >
      {JSON.stringify(snapshot)}
    </output>
  );
}

export function GalleryImageRuntime({
  children,
  detailOpen,
  resetKey
}: {
  children: React.ReactNode;
  detailOpen: boolean;
  resetKey: string;
}) {
  const [runtime] = useState(createRuntime);
  const previousResetKeyRef = useRef(resetKey);
  const development = import.meta.env?.DEV === true;

  useLayoutEffect(() => {
    if (detailOpen) {
      runtime.scheduler.pauseGroup("gallery", {
        cancelPending: true,
        cancelRunning: true
      });
    } else {
      runtime.scheduler.resumeGroup("gallery");
    }
  }, [detailOpen, runtime]);

  useLayoutEffect(() => {
    if (import.meta.env?.DEV !== true) return;
    if (previousResetKeyRef.current === resetKey) return;
    previousResetKeyRef.current = resetKey;
    runtime.debug?.resetThumbnailFallbacks();
  }, [resetKey, runtime]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const fine = window.matchMedia("(pointer: fine)");
    const wide = window.matchMedia("(min-width: 1024px)");
    const updateConcurrency = () => {
      runtime.scheduler.setMaxConcurrent(
        preferredImageLoadConcurrency(window.matchMedia.bind(window))
      );
    };
    fine.addEventListener("change", updateConcurrency);
    wide.addEventListener("change", updateConcurrency);
    return () => {
      fine.removeEventListener("change", updateConcurrency);
      wide.removeEventListener("change", updateConcurrency);
    };
  }, [runtime]);

  useEffect(() => {
    let previousWidth = window.innerWidth;
    let previousHeight = currentViewportHeight();
    let frame: number | undefined;
    const updateForLayoutResize = () => {
      frame = undefined;
      const nextWidth = window.innerWidth;
      const nextHeight = currentViewportHeight();
      if (!shouldRefreshGalleryVisibility(
        { width: previousWidth, height: previousHeight },
        { width: nextWidth, height: nextHeight }
      )) {
        return;
      }
      previousWidth = nextWidth;
      previousHeight = nextHeight;
      // Small height-only changes are commonly mobile browser chrome. A real
      // width change, orientation change, or cumulative desktop resize refreshes
      // the screen-based margins at most once per animation frame.
      runtime.visibility.updateViewportHeight(nextHeight);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(updateForLayoutResize);
    };
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [runtime]);

  useEffect(() => {
    if (!development || !runtime.debug) return;
    const target = window as Window & {
      __IMAGESHOW_GALLERY_STATS__?: () => ReturnType<GalleryDebugController["snapshot"]>;
    };
    const getSnapshot = runtime.debug.snapshot;
    target.__IMAGESHOW_GALLERY_STATS__ = getSnapshot;
    return () => {
      if (target.__IMAGESHOW_GALLERY_STATS__ === getSnapshot) {
        delete target.__IMAGESHOW_GALLERY_STATS__;
      }
    };
  }, [development, runtime]);

  useEffect(() => () => {
    // Task owners remove their DOM sources first. This group-level fence also
    // catches a task whose owner is concurrently leaving the tree. The
    // scheduler itself stays reusable during React StrictMode's effect replay.
    runtime.scheduler.cancelGroup("gallery");
    runtime.scheduler.cancelGroup("detail");
  }, [runtime]);

  const contextValue = useMemo(() => ({
    ...runtime,
    galleryPaused: detailOpen
  }), [detailOpen, runtime]);

  return (
    <GalleryImageRuntimeContext.Provider value={contextValue}>
      <ImageLoadSchedulerProvider scheduler={runtime.scheduler}>
        {children}
        {development && runtime.debug && (
          <GalleryDevelopmentStats debug={runtime.debug} />
        )}
      </ImageLoadSchedulerProvider>
    </GalleryImageRuntimeContext.Provider>
  );
}

export function useGalleryImageRuntime() {
  const runtime = useContext(GalleryImageRuntimeContext);
  if (!runtime) {
    throw new Error("Gallery image runtime is missing");
  }
  return runtime;
}
