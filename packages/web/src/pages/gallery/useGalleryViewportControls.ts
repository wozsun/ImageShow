import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getPageScrollY, isBodyScrollLocked } from "../../hooks/useBodyScrollLock.js";

const toolbarScrollDirectionThreshold = 8;
const filterDismissGestureThreshold = 12;
const filterWheelGestureGap = 600;
const backToTopViewportThreshold = 1;
// 与 styles/responsive.css 的画廊移动端断点保持一致。
const mobileGalleryMediaQuery = "(max-width: 760px)";

function blurFocusedToolbarElement(toolbar: HTMLElement) {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && toolbar.contains(activeElement)) {
    activeElement.blur();
  }
}

function useMobileGalleryLayout(closeFilters: () => void) {
  const [mobileLayout, setMobileLayout] = useState(false);

  useEffect(() => {
    const viewport = window.matchMedia(mobileGalleryMediaQuery);
    const updateLayout = (matches: boolean) => {
      setMobileLayout(matches);
      if (!matches) closeFilters();
    };
    const onLayoutChange = (event: MediaQueryListEvent) => updateLayout(event.matches);

    updateLayout(viewport.matches);
    viewport.addEventListener("change", onLayoutChange);
    return () => viewport.removeEventListener("change", onLayoutChange);
  }, [closeFilters]);

  return mobileLayout;
}

function useGalleryToolbarVisibility(
  toolbarRef: RefObject<HTMLElement | null>,
  lockedOpen: boolean
) {
  const [visible, setVisible] = useState(true);
  const scrollAnchorRef = useRef(0);
  const toolbarHeightRef = useRef(0);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const updateToolbarHeight = () => {
      toolbarHeightRef.current = toolbar.getBoundingClientRect().height;
    };
    const observer = new ResizeObserver(updateToolbarHeight);
    observer.observe(toolbar);
    updateToolbarHeight();

    scrollAnchorRef.current = getPageScrollY();
    if (lockedOpen) {
      setVisible(true);
      return () => observer.disconnect();
    }

    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      // 模态框固定 body 时 window.scrollY 会暂时归零。这不是用户滚动，不能据此
      // 改变工具栏状态，否则关闭详情恢复原位置时会看到工具栏闪烁。
      if (isBodyScrollLocked()) return;
      const scrollTop = Math.max(0, getPageScrollY());
      // 下拉菜单通过 Portal 渲染在 body；菜单展开时保持其触发工具栏可见，
      // 避免触发器被收起而浮层仍停留在页面上。
      if (toolbar.querySelector('[aria-expanded="true"]')) {
        scrollAnchorRef.current = scrollTop;
        setVisible(true);
        return;
      }
      if (scrollTop <= toolbarScrollDirectionThreshold) {
        scrollAnchorRef.current = scrollTop;
        setVisible(true);
        return;
      }
      const delta = scrollTop - scrollAnchorRef.current;
      if (Math.abs(delta) < toolbarScrollDirectionThreshold) return;
      scrollAnchorRef.current = scrollTop;
      if (delta < 0) {
        setVisible(true);
        return;
      }
      // 工具栏仍占据文档流高度。等页面至少滚过同等距离再隐藏，避免其原始
      // 占位来不及滚出视口而暴露成一整块空白。
      if (scrollTop < toolbarHeightRef.current) return;
      // inert 会把隐藏工具栏移出交互与无障碍树；先释放内部焦点，避免浏览器
      // 保留一个已不可见的焦点目标，也无需再叠加容易产生时序警告的 aria-hidden。
      blurFocusedToolbarElement(toolbar);
      setVisible(false);
    };
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [lockedOpen, toolbarRef]);

  return visible;
}

function isWithinGalleryFilterSurface(panel: HTMLElement, target: EventTarget | null) {
  const targetElement = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  return Boolean(targetElement && (
    panel.contains(targetElement)
    // SelectMenu 与 FacetSelector 的菜单通过 Portal 挂到 body，仍属于筛选交互。
    || targetElement.closest(".select-menu, .facet-select-menu")
  ));
}

function useCloseMobileFiltersOnOutsideScroll(
  panelRef: RefObject<HTMLElement | null>,
  active: boolean,
  closeFilters: () => void
) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!active || !panel) return;

    let pointerGesture: {
      pointerId: number;
      startX: number;
      startY: number;
    } | null = null;
    let outsideScrollAnchor: number | null = null;
    let outsideWheelDelta = 0;
    let lastWheelEventAt = 0;

    const resetOutsideIntent = () => {
      pointerGesture = null;
      outsideScrollAnchor = null;
      outsideWheelDelta = 0;
      lastWheelEventAt = 0;
    };
    const dismiss = () => {
      resetOutsideIntent();
      closeFilters();
    };
    const onPointerDown = (event: PointerEvent) => {
      resetOutsideIntent();
      if (!event.isPrimary || isWithinGalleryFilterSurface(panel, event.target)) return;
      pointerGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      outsideScrollAnchor = window.scrollY;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerGesture || event.pointerId !== pointerGesture.pointerId) return;
      const horizontalDistance = Math.abs(event.clientX - pointerGesture.startX);
      const verticalDistance = Math.abs(event.clientY - pointerGesture.startY);
      if (
        verticalDistance >= filterDismissGestureThreshold
        && verticalDistance > horizontalDistance
      ) {
        dismiss();
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pointerGesture?.pointerId === event.pointerId) pointerGesture = null;
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (pointerGesture?.pointerId !== event.pointerId) return;
      // 浏览器接管触控并开始原生滚动时会发出 pointercancel。直接关闭可避免
      // sticky 工具栏在等待后续 scrollY 更新期间仍被展开状态锁定。
      dismiss();
    };
    const onWheel = (event: WheelEvent) => {
      if (isWithinGalleryFilterSurface(panel, event.target)) {
        resetOutsideIntent();
        return;
      }
      const maxScrollY = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
      const canScrollPage = event.deltaY < 0
        ? window.scrollY > 0
        : window.scrollY < maxScrollY;
      if (!canScrollPage) {
        resetOutsideIntent();
        return;
      }
      const now = performance.now();
      if (now - lastWheelEventAt > filterWheelGestureGap) outsideWheelDelta = 0;
      lastWheelEventAt = now;
      outsideWheelDelta += Math.abs(event.deltaY);
      if (outsideWheelDelta >= filterDismissGestureThreshold) dismiss();
    };
    const onScroll = () => {
      if (outsideScrollAnchor === null || isBodyScrollLocked()) return;
      if (Math.abs(window.scrollY - outsideScrollAnchor) < filterDismissGestureThreshold) return;
      dismiss();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("scroll", onScroll);
    };
  }, [active, closeFilters, panelRef]);
}

function useBackToTopVisibility() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      if (isBodyScrollLocked()) return;
      setVisible(window.scrollY >= window.innerHeight * backToTopViewportThreshold);
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  return visible;
}

export function scrollGalleryToTop() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

export function useGalleryViewportControls() {
  const [filterPanelState, setFilterPanelState] = useState({
    open: false,
    menuDismissSignal: 0,
  });
  const toolbarRef = useRef<HTMLElement | null>(null);
  const filterPanelRef = useRef<HTMLDivElement | null>(null);
  const closeFilters = useCallback(() => {
    setFilterPanelState((current) => current.open
      ? { open: false, menuDismissSignal: current.menuDismissSignal + 1 }
      : current);
  }, []);
  const toggleFilters = useCallback(() => {
    setFilterPanelState((current) => current.open
      ? { open: false, menuDismissSignal: current.menuDismissSignal + 1 }
      : { ...current, open: true });
  }, []);
  const filtersOpen = filterPanelState.open;
  const mobileLayout = useMobileGalleryLayout(closeFilters);
  const mobileFiltersOpen = mobileLayout && filtersOpen;
  const toolbarVisible = useGalleryToolbarVisibility(toolbarRef, mobileFiltersOpen);
  useCloseMobileFiltersOnOutsideScroll(filterPanelRef, mobileFiltersOpen, closeFilters);
  const backToTopVisible = useBackToTopVisibility();

  return {
    backToTopVisible,
    closeFilters,
    filterPanelRef,
    filterMenuDismissSignal: filterPanelState.menuDismissSignal,
    filtersOpen,
    toggleFilters,
    toolbarRef,
    toolbarVisible,
  };
}
