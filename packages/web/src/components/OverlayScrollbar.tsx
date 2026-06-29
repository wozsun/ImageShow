import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

type Metrics = { visible: boolean; top: number; height: number; right: number };

const HIDE_DELAY = 900;
const EDGE_ZONE = 24;
const MIN_HANDLE = 36;
// Only drive the custom bar on a fine-pointer, hover-capable, non-high-contrast
// device. Touch/coarse devices already get a non-reserving native overlay bar,
// and forced-colors users are better served by the native high-contrast bar.
const ENABLE_QUERY = "(hover: hover) and (pointer: fine) and (forced-colors: none)";

// A floating, auto-hiding overlay scrollbar. With no target it drives the
// document (window) scroll and hides the native page bar via CSS so the layout
// never shifts. With a `targetRef` it drives that element's scroll instead (used
// for modal scroll containers), drawing a fixed handle over the element's right
// edge. Scrolling stays native, so scroll-locks/sticky/infinite-scroll are
// unaffected. Renders nothing on unsupported devices (native bar stays).
export function OverlayScrollbar({ targetRef, pageEdge }: { targetRef?: RefObject<HTMLElement | null>; pageEdge?: boolean } = {}) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(ENABLE_QUERY);
    const sync = () => setEnabled(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // The window-mode bar hides the native page scrollbar; element mode hides the
  // native bar on its own container (done in the handle effect via a class).
  useEffect(() => {
    if (!enabled || targetRef) return;
    document.documentElement.classList.add("has-overlay-scrollbar");
    return () => document.documentElement.classList.remove("has-overlay-scrollbar");
  }, [enabled, targetRef]);

  if (!enabled) return null;
  return <OverlayScrollbarHandle targetRef={targetRef} pageEdge={pageEdge} />;
}

function OverlayScrollbarHandle({ targetRef, pageEdge }: { targetRef?: RefObject<HTMLElement | null>; pageEdge?: boolean }) {
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
    // In element mode the target is already mounted (the scrollbar is rendered
    // after its container in the same commit); bail if somehow absent.
    if (targetRef && !el) return;
    if (el) el.classList.add("overlay-scroll-host");

    const isLocked = () => windowMode && document.body.style.position === "fixed";
    const read = () => {
      if (el) {
        const rect = el.getBoundingClientRect();
        // pageEdge pins the bar to the viewport's right edge (the whole-page edge) rather than
        // the scroll container's own right edge.
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
      const handle = Math.max(MIN_HANDLE, (viewport / total) * viewport);
      const maxScroll = total - viewport;
      const top = offsetTop + (maxScroll > 0 ? (scroll / maxScroll) * (viewport - handle) : 0);
      setMetrics({ visible: true, top, height: handle, right });
    };
    // Coalesce the bursty scroll/resize/observer/pointer events into one
    // measurement per frame to avoid redundant layout reads and re-renders.
    let framePending = false;
    const scheduleRecompute = () => {
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
      if (near >= 0 && near <= EDGE_ZONE && event.clientY >= offsetTop && event.clientY <= offsetTop + viewport) { scheduleRecompute(); reveal(); }
    };

    recompute();
    const scrollTarget: EventTarget = el ?? window;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    // Content height changes (e.g. gallery infinite scroll, modal list growth)
    // must re-fit the handle.
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
    // Capture the pointer so the handle keeps tracking even when the cursor
    // leaves it, without window-level listeners or text selection.
    handleEl.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    setActive(true);
    const onMove = (moveEvent: PointerEvent) => {
      if (travel <= 0) return;
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
  if (targetRef) {
    // Element mode: a single fixed handle positioned over the container's right edge.
    return (
      <div
        className={`overlay-scrollbar-handle is-floating ${activeClass} ${draggingClass}`.trim()}
        style={{ top: metrics.top, height: metrics.height, right: metrics.right }}
        onPointerDown={onHandlePointerDown}
        aria-hidden="true"
      />
    );
  }
  return (
    <div className={`overlay-scrollbar ${activeClass}`.trim()} aria-hidden="true">
      <div
        className={`overlay-scrollbar-handle ${draggingClass}`.trim()}
        style={{ top: metrics.top, height: metrics.height }}
        onPointerDown={onHandlePointerDown}
      />
    </div>
  );
}
