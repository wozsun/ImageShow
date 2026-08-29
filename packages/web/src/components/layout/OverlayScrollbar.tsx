import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import { isPageScrollLocked } from "../../hooks/usePageScrollLock.js";

type Metrics = {
  visible: boolean;
  top: number;
  height: number;
  right: number;
  trackHeight: number;
};

const HIDE_DELAY = 900;
const EDGE_ZONE = 24;
const MIN_HANDLE = 36;

const ENABLE_QUERY = "(hover: hover) and (pointer: fine) and (forced-colors: none)";

function handleTransform(top: number) {
  return `translateY(${top}px)`;
}

type OverlayScrollbarProps = {
  targetRef?: RefObject<HTMLElement | null>;
  containerRef?: RefObject<HTMLElement | null>;
  topInsetRef?: RefObject<HTMLElement | null>;
  pageEdge?: boolean;
  tone?: "default" | "dark";
  layer?: "default" | "menu";
  enableOnTouch?: boolean;
};

export function OverlayScrollbar({
  targetRef,
  containerRef,
  topInsetRef,
  pageEdge,
  tone = "default",
  layer = "default",
  enableOnTouch = false,
}: OverlayScrollbarProps = {}) {
  const [enabled, setEnabled] = useState(false);
  const enableQuery = enableOnTouch ? "(forced-colors: none)" : ENABLE_QUERY;

  useEffect(() => {
    const mq = window.matchMedia(enableQuery);
    // 默认仅在精确指针环境启用；指定触控支持时仍保留强制色模式的系统滚动条。
    const sync = () => setEnabled(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [enableQuery]);

  useEffect(() => {
    if (!enabled || targetRef) return;
    document.documentElement.classList.add("has-overlay-scrollbar");
    return () => document.documentElement.classList.remove("has-overlay-scrollbar");
  }, [enabled, targetRef]);

  useLayoutEffect(() => {
    const target = pageEdge ? targetRef?.current : null;
    if (!target) return;
    target.classList.add("page-edge-scroll-host");
    return () => target.classList.remove("page-edge-scroll-host");
  }, [pageEdge, targetRef]);

  if (!enabled) return null;
  return (
    <OverlayScrollbarHandle
      targetRef={targetRef}
      containerRef={containerRef}
      topInsetRef={topInsetRef}
      pageEdge={pageEdge}
      tone={tone}
      layer={layer}
    />
  );
}

function OverlayScrollbarHandle({
  targetRef,
  containerRef,
  topInsetRef,
  pageEdge,
  tone,
  layer,
}: OverlayScrollbarProps) {
  const [metrics, setMetrics] = useState<Metrics>({
    visible: false,
    top: 0,
    height: 0,
    right: 0,
    trackHeight: 0,
  });
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const activeRef = useRef(false);
  const draggingRef = useRef(false);
  const metricsRef = useRef(metrics);

  const updateActive = (next: boolean) => {
    if (activeRef.current === next) return;
    activeRef.current = next;
    setActive(next);
  };

  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!draggingRef.current) updateActive(false);
    }, HIDE_DELAY);
  };

  useLayoutEffect(() => {
    if (handleRef.current) {
      handleRef.current.style.transform = handleTransform(
        metricsRef.current.top
      );
    }
  });

  useEffect(() => {
    const el = targetRef?.current ?? null;
    const windowMode = !targetRef;
    let observer: ResizeObserver | null = null;

    if (targetRef && !el) return;
    if (el) el.classList.add("overlay-scroll-host");

    const isLocked = () => windowMode && isPageScrollLocked();
    const read = () => {
      if (el) {
        const rect = el.getBoundingClientRect();
        const containerRect = containerRef?.current?.getBoundingClientRect();
        const insetHeight = Math.max(0, topInsetRef?.current?.getBoundingClientRect().height ?? 0);
        const viewport = Math.max(0, el.clientHeight - insetHeight);
        // 扣除固定头部后，总高度与视口高度仍保留相同的最大滚动距离。
        const total = Math.max(viewport, el.scrollHeight - insetHeight);
        const edgeRight = pageEdge ? window.innerWidth : rect.right;
        const hitTop = rect.top + insetHeight;
        return {
          viewport,
          total,
          scroll: el.scrollTop,
          offsetTop: containerRect
            ? rect.top - containerRect.top + insetHeight
            : hitTop,
          hitTop,
          right: containerRect
            ? Math.max(0, containerRect.right - rect.right)
            : pageEdge
              ? 0
              : Math.max(0, window.innerWidth - rect.right),
          edgeRight,
        };
      }
      const viewport = window.innerHeight;
      return {
        viewport,
        total: Math.max(viewport, document.documentElement.scrollHeight),
        scroll: window.scrollY,
        offsetTop: 0,
        hitTop: 0,
        right: 0,
        edgeRight: window.innerWidth,
      };
    };

    let frame: number | undefined;
    const recompute = () => {
      const { viewport, total, scroll, offsetTop, right } = read();
      if (isLocked() || viewport <= 1 || total <= viewport + 1) {
        const current = metricsRef.current;
        if (!current.visible) return;
        const next = { ...current, visible: false };
        metricsRef.current = next;
        setMetrics(next);
        return;
      }
      // 滚动条手柄高度按可视区域占全文比例计算，并设最小值确保可拖拽。
      const handle = Math.min(viewport, Math.max(MIN_HANDLE, (viewport / total) * viewport));
      const maxScroll = total - viewport;
      const top = offsetTop + (maxScroll > 0 ? (scroll / maxScroll) * (viewport - handle) : 0);
      const current = metricsRef.current;
      const next = {
        visible: true,
        top,
        height: handle,
        right,
        trackHeight: viewport
      };
      metricsRef.current = next;
      // 滚动位置是逐帧瞬态值：直接移动手柄，避免把每一帧都提升为 React 根更新；
      // 可见性、尺寸和拖拽状态仍由 React 持有。
      if (handleRef.current) {
        handleRef.current.style.transform = handleTransform(top);
      }
      if (
        current.visible !== next.visible
        || current.height !== next.height
        || current.right !== next.right
        || current.trackHeight !== next.trackHeight
      ) {
        setMetrics(next);
      }
    };

    let framePending = false;
    const scheduleRecompute = () => {
      // scroll/resize/pointermove 可能高频触发，统一合并到下一帧读取布局，减少强制同步 reflow。
      if (framePending) return;
      framePending = true;
      frame = window.requestAnimationFrame(() => { framePending = false; recompute(); });
    };

    const reveal = () => {
      updateActive(true);
      scheduleHide();
    };

    const onScroll = () => { scheduleRecompute(); reveal(); };
    const onAncestorScroll = () => scheduleRecompute();
    const onResize = () => scheduleRecompute();
    const onPointerMove = (event: PointerEvent) => {
      if (windowMode) {
        const distanceFromPageEdge = window.innerWidth - event.clientX;
        if (distanceFromPageEdge < 0 || distanceFromPageEdge > EDGE_ZONE) return;
      }
      const { hitTop, viewport, edgeRight } = read();
      const near = edgeRight - event.clientX;
      // 鼠标靠近目标滚动区域右边缘时才显示，避免浮层长期遮挡内容。
      if (near >= 0 && near <= EDGE_ZONE && event.clientY >= hitTop && event.clientY <= hitTop + viewport) { scheduleRecompute(); reveal(); }
    };

    const scrollTarget: EventTarget = el ?? window;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    // 浮动手柄使用 fixed 定位，任一祖先滚动都会改变目标元素的视口坐标。
    if (el) window.addEventListener("scroll", onAncestorScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    observer = new ResizeObserver(scheduleRecompute);
    observer.observe(el ?? document.body);
    if (containerRef?.current) observer.observe(containerRef.current);
    if (topInsetRef?.current) observer.observe(topInsetRef.current);
    // 页面锁的权威状态由 html.modal-open 表达。只观察根元素 class，避免恢复
    // 对整个页面子树的监听，同时确保锁定开始和结束时立即更新滚动条。
    const pageLockObserver = windowMode ? new MutationObserver(scheduleRecompute) : null;
    pageLockObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    recompute();
    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
      if (el) window.removeEventListener("scroll", onAncestorScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      observer?.disconnect();
      pageLockObserver?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.clearTimeout(hideTimer.current);
      if (el) el.classList.remove("overlay-scroll-host");
    };
  }, [containerRef, pageEdge, targetRef, topInsetRef]);

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = targetRef?.current ?? null;
    const handleEl = event.currentTarget;
    const maxScroll = el
      ? el.scrollHeight - el.clientHeight
      : document.documentElement.scrollHeight - window.innerHeight;
    const travel = metricsRef.current.trackHeight - metricsRef.current.height;
    const startY = event.clientY;
    const startScroll = el ? el.scrollTop : window.scrollY;

    handleEl.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    window.clearTimeout(hideTimer.current);
    setDragging(true);
    updateActive(true);
    const onMove = (moveEvent: PointerEvent) => {
      if (travel <= 0) return;
      // 拖动距离按“手柄可移动距离 : 内容可滚动距离”换算，窗口和容器模式共用同一套算法。
      const delta = ((moveEvent.clientY - startY) / travel) * maxScroll;
      if (el) el.scrollTop = startScroll + delta; else window.scrollTo(0, startScroll + delta);
    };
    const onUp = () => {
      draggingRef.current = false;
      setDragging(false);
      handleEl.releasePointerCapture(event.pointerId);
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", onUp);
      handleEl.removeEventListener("pointercancel", onUp);
      scheduleHide();
    };
    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", onUp);
    handleEl.addEventListener("pointercancel", onUp);
  };

  if (!metrics.visible) return null;
  const activeClass = active || dragging ? "is-active" : "";
  const draggingClass = dragging ? "is-dragging" : "";
  const toneClass = tone === "dark" ? "is-dark" : "";
  const layerClass = layer === "menu" ? "is-menu" : "";
  if (targetRef) {
    const placementClass = containerRef ? "is-contained" : "is-floating";
    return (
      <div
        ref={handleRef}
        className={`overlay-scrollbar-handle ${placementClass} ${toneClass} ${layerClass} ${activeClass} ${draggingClass}`.trim()}
        style={{
          top: 0,
          transform: handleTransform(metrics.top),
          height: metrics.height,
          right: metrics.right
        }}
        onPointerDown={onHandlePointerDown}
        aria-hidden="true"
      />
    );
  }
  return (
    <div className={`overlay-scrollbar ${activeClass}`.trim()} aria-hidden="true">
      <div
        ref={handleRef}
        className={`overlay-scrollbar-handle ${toneClass} ${layerClass} ${draggingClass}`.trim()}
        style={{
          top: 0,
          transform: handleTransform(metrics.top),
          height: metrics.height
        }}
        onPointerDown={onHandlePointerDown}
      />
    </div>
  );
}
