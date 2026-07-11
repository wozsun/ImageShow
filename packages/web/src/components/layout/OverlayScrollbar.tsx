import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

type Metrics = { visible: boolean; top: number; height: number; right: number };

const HIDE_DELAY = 900;
const EDGE_ZONE = 24;
const MIN_HANDLE = 36;

const ENABLE_QUERY = "(hover: hover) and (pointer: fine) and (forced-colors: none)";

type OverlayScrollbarProps = {
  targetRef?: RefObject<HTMLElement | null>;
  pageEdge?: boolean;
  tone?: "default" | "dark";
};

export function OverlayScrollbar({ targetRef, pageEdge, tone = "default" }: OverlayScrollbarProps = {}) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(ENABLE_QUERY);
    // 仅在鼠标/触控板且非强制色模式下启用，避免移动端和高对比度环境里替代系统滚动条。
    const sync = () => setEnabled(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!enabled || targetRef) return;
    document.documentElement.classList.add("has-overlay-scrollbar");
    return () => document.documentElement.classList.remove("has-overlay-scrollbar");
  }, [enabled, targetRef]);

  if (!enabled) return null;
  return <OverlayScrollbarHandle targetRef={targetRef} pageEdge={pageEdge} tone={tone} />;
}

function OverlayScrollbarHandle({ targetRef, pageEdge, tone }: OverlayScrollbarProps) {
  const [metrics, setMetrics] = useState<Metrics>({ visible: false, top: 0, height: 0, right: 0 });
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const draggingRef = useRef(false);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  useEffect(() => {
    const el = targetRef?.current ?? null;
    const windowMode = !targetRef;

    if (targetRef && !el) return;
    if (el) el.classList.add("overlay-scroll-host");

    const isLocked = () => windowMode && document.body.style.position === "fixed";
    const read = () => {
      if (el) {
        const rect = el.getBoundingClientRect();
        // targetRef 模式用于内部滚动容器；right 按容器右边缘计算，pageEdge=true 时贴到视口最右。
        return { viewport: el.clientHeight, total: el.scrollHeight, scroll: el.scrollTop, offsetTop: rect.top, right: pageEdge ? 0 : Math.max(0, window.innerWidth - rect.right) };
      }
      return { viewport: window.innerHeight, total: document.documentElement.scrollHeight, scroll: window.scrollY, offsetTop: 0, right: 0 };
    };

    let frame: number | undefined;
    const recompute = () => {
      const { viewport, total, scroll, offsetTop, right } = read();
      if (isLocked() || total <= viewport + 1) {
        setMetrics((current) => (current.visible ? { ...current, visible: false } : current));
        return;
      }
      // 滚动条手柄高度按可视区域占全文比例计算，并设最小值确保可拖拽。
      const handle = Math.max(MIN_HANDLE, (viewport / total) * viewport);
      const maxScroll = total - viewport;
      const top = offsetTop + (maxScroll > 0 ? (scroll / maxScroll) * (viewport - handle) : 0);
      setMetrics({ visible: true, top, height: handle, right });
    };

    let framePending = false;
    const scheduleRecompute = () => {
      // scroll/resize/pointermove 可能高频触发，统一合并到下一帧读取布局，减少强制同步 reflow。
      if (framePending) return;
      framePending = true;
      frame = window.requestAnimationFrame(() => { framePending = false; recompute(); });
    };

    const reveal = () => {
      setActive(true);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => { if (!draggingRef.current) setActive(false); }, HIDE_DELAY);
    };

    const onScroll = () => { scheduleRecompute(); reveal(); };
    const onResize = () => scheduleRecompute();
    const onPointerMove = (event: PointerEvent) => {
      const { offsetTop, viewport, right } = read();
      const near = (window.innerWidth - right) - event.clientX;
      // 鼠标靠近目标滚动区域右边缘时才显示，避免浮层长期遮挡内容。
      if (near >= 0 && near <= EDGE_ZONE && event.clientY >= offsetTop && event.clientY <= offsetTop + viewport) { scheduleRecompute(); reveal(); }
    };

    recompute();
    const scrollTarget: EventTarget = el ?? window;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const observer = new ResizeObserver(scheduleRecompute);
    observer.observe(el ?? document.body);
    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.clearTimeout(hideTimer.current);
      if (el) el.classList.remove("overlay-scroll-host");
    };
  }, [targetRef, pageEdge]);

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = targetRef?.current ?? null;
    const handleEl = event.currentTarget;
    const viewport = el ? el.clientHeight : window.innerHeight;
    const total = el ? el.scrollHeight : document.documentElement.scrollHeight;
    const maxScroll = total - viewport;
    const travel = viewport - metricsRef.current.height;
    const startY = event.clientY;
    const startScroll = el ? el.scrollTop : window.scrollY;

    handleEl.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    setActive(true);
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
    };
    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", onUp);
    handleEl.addEventListener("pointercancel", onUp);
  };

  if (!metrics.visible) return null;
  const activeClass = active || dragging ? "is-active" : "";
  const draggingClass = dragging ? "is-dragging" : "";
  const toneClass = tone === "dark" ? "is-dark" : "";
  if (targetRef) {
    return (
      <div
        className={`overlay-scrollbar-handle is-floating ${toneClass} ${activeClass} ${draggingClass}`.trim()}
        style={{ top: metrics.top, height: metrics.height, right: metrics.right }}
        onPointerDown={onHandlePointerDown}
        aria-hidden="true"
      />
    );
  }
  return (
    <div className={`overlay-scrollbar ${activeClass}`.trim()} aria-hidden="true">
      <div
        className={`overlay-scrollbar-handle ${toneClass} ${draggingClass}`.trim()}
        style={{ top: metrics.top, height: metrics.height }}
        onPointerDown={onHandlePointerDown}
      />
    </div>
  );
}
