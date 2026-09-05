import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode
} from "react";
import type { ShowOrder } from "@imageshow/shared/browser";
import { PublicStarfield } from "../../../components/layout/PublicStarfield.js";
import type { ShowImage } from "../show-layout.js";
import { ShowPixiRuntime } from "./show-pixi-runtime.js";
import type {
  ShowPixiSceneKind,
  ShowPixiVisibleItem
} from "./show-pixi-types.js";

function imageLabel(image: ShowImage) {
  const title = image.title?.trim();
  const author = image.author?.trim();
  if (title && author) return `${title}，作者 ${author}`;
  return title || author || `图片 ${image.id.slice(-12)}`;
}

export function ShowPixiStage({
  children,
  dataKey,
  dialogOpen,
  floatSizeIndex,
  images,
  onColumnsChange,
  onFloatSizeIndexChange,
  onManualVerticalMovement,
  onMotionActiveChange,
  onNeedImages,
  onOpen,
  order,
  reducedMotion,
  running,
  scene,
  speed,
  waterfallColumns
}: {
  children?: ReactNode;
  dataKey: string;
  dialogOpen: boolean;
  floatSizeIndex: number;
  images: readonly ShowImage[];
  onColumnsChange: (columns: number) => number;
  onFloatSizeIndexChange: (index: number) => number;
  onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  onMotionActiveChange: (active: boolean) => void;
  onNeedImages: () => void;
  onOpen: (image: ShowImage, opener: HTMLElement) => void;
  order: ShowOrder;
  reducedMotion: boolean;
  running: boolean;
  scene: ShowPixiSceneKind;
  speed: number;
  waterfallColumns: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const accessibilityRef = useRef<HTMLDivElement | null>(null);
  const statsRef = useRef<HTMLOutputElement | null>(null);
  const runtimeRef = useRef<ShowPixiRuntime | null>(null);
  const callbackRef = useRef({
    onColumnsChange,
    onFloatSizeIndexChange,
    onManualVerticalMovement,
    onMotionActiveChange,
    onNeedImages,
    onOpen
  });
  const [runtime, setRuntime] = useState<ShowPixiRuntime | null>(null);
  const [visibleItems, setVisibleItems] = useState<readonly ShowPixiVisibleItem[]>([]);
  const [initializationError, setInitializationError] = useState("");
  const [diagnosticsEnabled] = useState(() => (
    import.meta.env.DEV || window.__imageShowPixiDiagnostics === true
  ));
  callbackRef.current = {
    onColumnsChange,
    onFloatSizeIndexChange,
    onManualVerticalMovement,
    onMotionActiveChange,
    onNeedImages,
    onOpen
  };

  const handFocusToPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isTrusted || dialogOpen || !(event.target instanceof HTMLCanvasElement)) return;
    const list = accessibilityRef.current;
    const focused = list?.ownerDocument.activeElement;
    if (focused && list?.contains(focused)) {
      // Move the real DOM focus as well as its visual lease. Merely clearing
      // focusCard would be undone by the next visible-item reconciliation.
      event.currentTarget.focus({ preventScroll: true });
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let visibleTimer: number | undefined;
    let pendingVisible: readonly ShowPixiVisibleItem[] = [];
    const publishVisible = (items: readonly ShowPixiVisibleItem[]) => {
      if (disposed) return;
      pendingVisible = items;
      if (visibleTimer !== undefined) return;
      visibleTimer = window.setTimeout(() => {
        visibleTimer = undefined;
        if (!disposed) setVisibleItems(pendingVisible);
      }, 240);
    };
    // React Strict Mode runs a development-only setup/cleanup/setup cycle.
    // Defer the expensive asynchronous WebGL initialization by one microtask
    // so the discarded setup never creates a second Application or canvas.
    void Promise.resolve().then(() => {
      if (disposed) return null;
      return ShowPixiRuntime.create(host, {
        scene,
        images,
        dataKey,
        order,
        waterfallColumns,
        floatSizeIndex,
        running,
        reducedMotion,
        speed,
        statsElement: statsRef.current,
        onColumnsChange: (columns) => callbackRef.current.onColumnsChange(columns),
        onFloatSizeIndexChange: (index) => (
          callbackRef.current.onFloatSizeIndexChange(index)
        ),
        onManualVerticalMovement: (delta, pointerType) => (
          callbackRef.current.onManualVerticalMovement(delta, pointerType)
        ),
        onMotionActiveChange: (active) => {
          if (!disposed) callbackRef.current.onMotionActiveChange(active);
        },
        onNeedImages: () => {
          if (!disposed) callbackRef.current.onNeedImages();
        },
        onOpen: (image) => {
          // Canvas activation comes from a pointer, not the keyboard proxy.
          // Restoring focus to that proxy would grant a persistent focus/motion
          // lease to a card that was only clicked. Keyboard activation below
          // still returns to its actual button for continued navigation.
          callbackRef.current.onOpen(image, host);
        },
        onVisibleItems: publishVisible
      });
    }).then((created) => {
      if (!created) return;
      if (disposed) {
        created.destroy();
        return;
      }
      if (diagnosticsEnabled) created.exposeDebug();
      runtimeRef.current = created;
      setRuntime(created);
      setInitializationError("");
    }).catch((error: unknown) => {
      if (disposed) return;
      setInitializationError(
        error instanceof Error ? error.message : "WebGL 初始化失败"
      );
    });
    return () => {
      disposed = true;
      if (visibleTimer !== undefined) window.clearTimeout(visibleTimer);
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
    // The runtime is intentionally created exactly once per mounted route.
    // Subsequent data, scene and control changes use its imperative boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => runtime?.setScene(scene), [runtime, scene]);
  useEffect(() => {
    runtime?.setImages(images, dataKey, order);
  }, [runtime, images, dataKey, order]);
  useEffect(() => {
    runtime?.setWaterfallColumns(waterfallColumns);
  }, [runtime, waterfallColumns]);
  useEffect(() => {
    runtime?.setFloatSizeIndex(floatSizeIndex);
  }, [runtime, floatSizeIndex]);
  useEffect(() => runtime?.setSpeed(speed), [runtime, speed]);
  useEffect(() => runtime?.setRunning(running), [runtime, running]);
  useLayoutEffect(() => runtime?.setDialogOpen(dialogOpen), [runtime, dialogOpen]);

  useLayoutEffect(() => {
    const list = accessibilityRef.current;
    const focused = list?.ownerDocument.activeElement;
    // Removing a focused proxy does not dispatch blur. Reconcile against the
    // committed DOM so recycled/offscreen cards cannot retain its motion lease.
    runtime?.focusCard(!dialogOpen && focused && list?.contains(focused)
      ? focused.getAttribute("data-show-pixi-key") : null);
  }, [runtime, visibleItems, dialogOpen]);

  const sceneClassName = scene === "waterfall" ? "is-waterfall" : "is-float";

  return (
    <div
      className={`show-viewport show-pixi-viewport ${sceneClassName}`}
      data-show-pixi-stage=""
      data-show-scene={scene}
    >
      <div className="show-atmosphere" aria-hidden="true">
        <PublicStarfield />
      </div>
      <div
        ref={hostRef}
        className="show-pixi-canvas-host"
        tabIndex={-1}
        onPointerMoveCapture={handFocusToPointer}
        onPointerDownCapture={handFocusToPointer}
      />
      <div className="show-vignette" aria-hidden="true" />
      <div ref={accessibilityRef} className="show-pixi-accessibility sr-only" role="list">
        {visibleItems.map(({ key, image }) => (
          <div key={key} role="listitem">
            <button
              type="button"
              data-show-pixi-proxy=""
              data-image-id={image.id}
              data-show-pixi-key={key}
              aria-label={imageLabel(image)}
              onBlur={() => runtimeRef.current?.focusCard(null)}
              onClick={(event) => onOpen(image, event.currentTarget)}
              onFocus={() => {
                if (!dialogOpen) runtimeRef.current?.focusCard(key);
              }}
            >
              {imageLabel(image)}
            </button>
          </div>
        ))}
      </div>
      {initializationError && (
        <div className="show-query-state" role="alert">
          <p>PixiJS / WebGL 展映无法启动：{initializationError}</p>
        </div>
      )}
      {children}
      {diagnosticsEnabled && <output
        ref={statsRef}
        hidden
        data-show-pixi-debug-stats=""
      />}
    </div>
  );
}
