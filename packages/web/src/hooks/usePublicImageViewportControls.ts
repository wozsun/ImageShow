import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { isPageScrollLocked } from "./usePageScrollLock.js";
import { usePageScrollMovement } from "./usePageScrollMovement.js";
import { usePublicNavigationTopEdgeReveal } from "./usePublicNavigationTopEdgeReveal.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "./useMediaQuery.js";
import { useDismissiblePanel } from "./useDismissiblePanel.js";
import {
  isPublicNavigationInteracting,
  publicNavigationTopRevealThreshold
} from "../lib/ui/public-navigation.js";
import {
  advancePublicImageNavigation,
  initialPublicImageNavigationState,
  type PublicImageNavigationStage
} from "../lib/ui/public-image-navigation-visibility.js";

const backToTopViewportThreshold = 1;

function blurFocusedElement(element: HTMLElement) {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && element.contains(activeElement)) {
    activeElement.blur();
  }
}

function usePublicImageNavigationVisibility(
  toolbarRef: RefObject<HTMLElement | null>,
  lockedOpen: boolean,
  paused: boolean,
  headerPresent: boolean,
  trackPageScroll: boolean,
  mouseDragRevealsNavigation: boolean,
  autoHideAfterMs: number | undefined
) {
  const [height, setHeight] = useState(0);
  const [stage, setStage] = useState<PublicImageNavigationStage>("visible");
  const toolbarHeightRef = useRef(0);
  const navigationStateRef = useRef({ ...initialPublicImageNavigationState });
  const manualPositionRef = useRef(0);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const updateNavigationMeasurements = () => {
      const nextHeight = Math.ceil(toolbar.getBoundingClientRect().height);
      toolbarHeightRef.current = nextHeight;
      setHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const observer = new ResizeObserver(updateNavigationMeasurements);
    observer.observe(toolbar);
    updateNavigationMeasurements();
    return () => observer.disconnect();
  }, [headerPresent, toolbarRef]);

  useLayoutEffect(() => {
    navigationStateRef.current = { ...initialPublicImageNavigationState };
    setStage("visible");
  }, [headerPresent]);

  useLayoutEffect(() => {
    if (paused || !lockedOpen) return;
    navigationStateRef.current = { ...initialPublicImageNavigationState };
    setStage("visible");
  }, [lockedOpen, paused]);

  useLayoutEffect(() => {
    if (!paused) return;
    // A dialog freezes the current stage, unlike a navigation menu that must
    // stay visible. Discard unfinished scroll intent without changing stage.
    navigationStateRef.current = {
      ...navigationStateRef.current,
      direction: null,
      distance: 0
    };
  }, [paused]);

  usePublicNavigationTopEdgeReveal(() => {
    if (paused) return;
    navigationStateRef.current = { ...initialPublicImageNavigationState };
    setStage("visible");
  }, !paused);

  // Pause/lock changes cancel the pending timeout in the same commit.
  useLayoutEffect(() => {
    if (autoHideAfterMs === undefined || lockedOpen || paused || stage === "hidden") return;
    const toolbar = toolbarRef.current;
    const navigationStack = toolbar?.closest<HTMLElement>(".public-navigation-stack");
    if (!navigationStack) return;
    let timer: number | undefined;
    let disposed = false;
    const canAutoHide = () => (
      !document.hidden
      && navigationStateRef.current.stage !== "hidden"
      && !isPublicNavigationInteracting(navigationStack)
      && !navigationStack.querySelector('[aria-expanded="true"]')
    );
    const restartAutoHide = () => {
      window.clearTimeout(timer);
      timer = undefined;
      // Hover、焦点和 Portal 菜单都离开后，才重新计满等待时间。
      if (disposed || !canAutoHide()) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (disposed || !canAutoHide()) return;
        navigationStateRef.current = {
          stage: "hidden",
          direction: null,
          distance: 0
        };
        if (toolbar) blurFocusedElement(toolbar);
        setStage("hidden");
      }, autoHideAfterMs);
    };
    const onFocusOut = () => {
      // 等同一次焦点转移完成，避免读取到仍在导航内的旧焦点。
      queueMicrotask(restartAutoHide);
    };
    const observer = new MutationObserver(restartAutoHide);
    observer.observe(navigationStack, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
      subtree: true
    });
    navigationStack.addEventListener("mouseenter", restartAutoHide);
    navigationStack.addEventListener("mouseleave", restartAutoHide);
    navigationStack.addEventListener("focusin", restartAutoHide);
    navigationStack.addEventListener("focusout", onFocusOut);
    document.addEventListener("click", restartAutoHide, { capture: true, passive: true });
    document.addEventListener("visibilitychange", restartAutoHide);
    restartAutoHide();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      observer.disconnect();
      navigationStack.removeEventListener("mouseenter", restartAutoHide);
      navigationStack.removeEventListener("mouseleave", restartAutoHide);
      navigationStack.removeEventListener("focusin", restartAutoHide);
      navigationStack.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", restartAutoHide, true);
      document.removeEventListener("visibilitychange", restartAutoHide);
    };
  }, [autoHideAfterMs, lockedOpen, paused, stage, toolbarRef]);

  const advance = useCallback((delta: number, scrollTop: number, allowReveal = true) => {
    if (paused) return;
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    // 属性栏的 Select / Facet 菜单通过 Portal 渲染在 body；主导航菜单
    // 由 lockedOpen 暂停采样，二者都保持触发器与浮层处于同一可见状态。
    const menuOpen = Boolean(
      toolbar.querySelector('[aria-expanded="true"]')
    );
    const currentState = navigationStateRef.current;
    const navigationStack = toolbar.closest<HTMLElement>(".public-navigation-stack");
    if (
      !lockedOpen
      && !menuOpen
      && delta > 0
      && scrollTop > publicNavigationTopRevealThreshold
      && currentState.stage !== "hidden"
      && navigationStack
      && isPublicNavigationInteracting(navigationStack)
    ) {
      navigationStateRef.current = { stage: currentState.stage, direction: null, distance: 0 };
      return;
    }
    const nextState = advancePublicImageNavigation(currentState, {
      delta,
      headerPresent,
      scrollTop,
      toolbarHeight: toolbarHeightRef.current,
      lockedOpen: lockedOpen || menuOpen,
      allowReveal
    });
    navigationStateRef.current = nextState;
    if (nextState.stage === currentState.stage) return;

    // inert 会把隐藏工具栏移出交互与无障碍树；先释放内部焦点，避免浏览器
    // 保留一个已不可见的焦点目标。主导航由 AppHeader 在自身隐藏时清理焦点。
    if (
      currentState.stage !== "hidden"
      && nextState.stage === "hidden"
    ) {
      blurFocusedElement(toolbar);
    }
    setStage(nextState.stage);
  }, [headerPresent, lockedOpen, paused, toolbarRef]);

  usePageScrollMovement(({ delta, position }) => {
    advance(delta, position.top);
  }, trackPageScroll && !lockedOpen && !paused);

  const advanceManual = useCallback((delta: number, pointerType?: string) => {
    if (paused || !Number.isFinite(delta) || delta === 0) return;
    manualPositionRef.current = Math.max(
      0,
      manualPositionRef.current + delta
    );
    advance(
      delta,
      manualPositionRef.current,
      mouseDragRevealsNavigation || pointerType !== "mouse"
    );
  }, [advance, mouseDragRevealsNavigation, paused]);

  const resetManual = useCallback(() => {
    manualPositionRef.current = 0;
    navigationStateRef.current = { ...initialPublicImageNavigationState };
    setStage("visible");
  }, []);

  return {
    advanceManual,
    headerVisible: headerPresent && stage === "visible",
    height,
    resetManual,
    toolbarVisible: stage !== "hidden"
  };
}

function useBackToTopVisibility(enabled: boolean) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      if (isPageScrollLocked()) return;
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
  }, [enabled]);

  return visible;
}

export function scrollPublicImagePageToTop() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

export function usePublicImageViewportControls({
  autoHideAfterMs,
  headerPresent = true,
  paused = false,
  movement = "page"
}: {
  autoHideAfterMs?: number;
  headerPresent?: boolean;
  paused?: boolean;
  movement?: "page" | "manual";
} = {}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [headerMenuExpanded, setHeaderMenuExpanded] = useState(false);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const clearFiltersRef = useRef<HTMLButtonElement | null>(null);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);

  useLayoutEffect(() => {
    if (!headerPresent) setHeaderMenuExpanded(false);
  }, [headerPresent]);

  const disclosure = useDismissiblePanel({
    open: filtersOpen,
    onOpenChange: setFiltersOpen,
    enabled: mobileLayout,
    resetKey: mobileLayout,
    auxiliarySurfaceRef: clearFiltersRef
  });
  const toggleFilters = useCallback(() => {
    disclosure.setOpen(!filtersOpen, filtersOpen
      ? { restoreFocus: true }
      : undefined);
  }, [disclosure.setOpen, filtersOpen]);

  const mobileFiltersOpen = mobileLayout && filtersOpen;
  const navigationLockedOpen = mobileFiltersOpen
    || (headerPresent && headerMenuExpanded);
  const {
    advanceManual: advanceManualNavigation,
    headerVisible,
    height: toolbarHeight,
    resetManual: resetManualNavigation,
    toolbarVisible
  } = usePublicImageNavigationVisibility(
    toolbarRef,
    navigationLockedOpen,
    paused,
    headerPresent,
    movement === "page",
    mobileLayout,
    autoHideAfterMs
  );
  const backToTopVisible = useBackToTopVisibility(movement === "page");

  return {
    advanceManualNavigation,
    backToTopVisible,
    filterPanelHidden: disclosure.panelHidden,
    filterPanelRef: disclosure.panelRef,
    filterMenuDismissSignal: disclosure.menuDismissSignal,
    filterToggleRef: disclosure.triggerRef,
    clearFiltersRef,
    dismissFilterMenus: disclosure.dismissMenus,
    filtersOpen,
    headerVisible,
    onHeaderMenuExpandedChange: setHeaderMenuExpanded,
    resetManualNavigation,
    toggleFilters,
    toolbarHeight,
    toolbarRef,
    toolbarVisible,
  };
}
