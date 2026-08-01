import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { isPageScrollLocked } from "../../hooks/usePageScrollLock.js";
import { usePageScrollMovement } from "../../hooks/usePageScrollMovement.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import { useDismissiblePanel } from "../../hooks/useDismissiblePanel.js";
import {
  advanceGalleryNavigation,
  initialGalleryNavigationState,
  type GalleryNavigationStage
} from "./gallery-navigation-visibility.js";

const backToTopViewportThreshold = 1;

function blurFocusedElement(element: HTMLElement) {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && element.contains(activeElement)) {
    activeElement.blur();
  }
}

function useGalleryNavigationVisibility(
  toolbarRef: RefObject<HTMLElement | null>,
  lockedOpen: boolean,
  headerPresent: boolean
) {
  const [height, setHeight] = useState(0);
  const [stage, setStage] = useState<GalleryNavigationStage>("visible");
  const toolbarHeightRef = useRef(0);
  const navigationStateRef = useRef({ ...initialGalleryNavigationState });

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const updateToolbarHeight = () => {
      const nextHeight = Math.ceil(toolbar.getBoundingClientRect().height);
      toolbarHeightRef.current = nextHeight;
      setHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const observer = new ResizeObserver(updateToolbarHeight);
    observer.observe(toolbar);
    updateToolbarHeight();
    return () => observer.disconnect();
  }, [toolbarRef]);

  useLayoutEffect(() => {
    navigationStateRef.current = { ...initialGalleryNavigationState };
    setStage("visible");
  }, [headerPresent]);

  useLayoutEffect(() => {
    if (!lockedOpen) return;
    navigationStateRef.current = { ...initialGalleryNavigationState };
    setStage("visible");
  }, [lockedOpen]);

  usePageScrollMovement(({ delta, position }) => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    // 属性栏的 Select / Facet 菜单通过 Portal 渲染在 body；主导航菜单
    // 由 lockedOpen 暂停采样，二者都保持触发器与浮层处于同一可见状态。
    const menuOpen = Boolean(
      toolbar.querySelector('[aria-expanded="true"]')
    );
    const currentState = navigationStateRef.current;
    const nextState = advanceGalleryNavigation(currentState, {
      delta,
      headerPresent,
      scrollTop: position.top,
      toolbarHeight: toolbarHeightRef.current,
      lockedOpen: menuOpen
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
  }, !lockedOpen);

  return {
    headerVisible: headerPresent && stage === "visible",
    height,
    toolbarVisible: stage !== "hidden"
  };
}

function useBackToTopVisibility() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
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
  }, []);

  return visible;
}

export function scrollGalleryToTop() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

export function useGalleryViewportControls({
  headerPresent = true
}: {
  headerPresent?: boolean;
} = {}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [headerMenuExpanded, setHeaderMenuExpanded] = useState(false);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);

  useLayoutEffect(() => {
    if (!headerPresent) setHeaderMenuExpanded(false);
  }, [headerPresent]);

  const disclosure = useDismissiblePanel({
    open: filtersOpen,
    onOpenChange: setFiltersOpen,
    enabled: mobileLayout,
    resetKey: mobileLayout
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
    headerVisible,
    height: toolbarHeight,
    toolbarVisible
  } = useGalleryNavigationVisibility(
    toolbarRef,
    navigationLockedOpen,
    headerPresent
  );
  const backToTopVisible = useBackToTopVisibility();

  return {
    backToTopVisible,
    filterPanelHidden: disclosure.panelHidden,
    filterPanelRef: disclosure.panelRef,
    filterMenuDismissSignal: disclosure.menuDismissSignal,
    filterToggleRef: disclosure.triggerRef,
    filtersOpen,
    headerVisible,
    onHeaderMenuExpandedChange: setHeaderMenuExpanded,
    toggleFilters,
    toolbarHeight,
    toolbarRef,
    toolbarVisible,
  };
}
