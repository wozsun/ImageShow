import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import { getPageScrollY, isPageScrollLocked } from "../../hooks/usePageScrollLock.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../hooks/useMediaQuery.js";
import { useDismissiblePanel } from "../../hooks/useDismissiblePanel.js";
import {
  normalizePageScrollPosition,
  pageScrollDelta
} from "../../lib/ui/page-scroll-position.js";
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

function currentPageScrollPosition() {
  const contentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0
  );
  return normalizePageScrollPosition(
    getPageScrollY(),
    contentHeight,
    window.innerHeight
  );
}

function useGalleryNavigationVisibility(
  toolbarRef: RefObject<HTMLElement | null>,
  lockedOpen: boolean
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
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    let previousPosition = currentPageScrollPosition();
    if (lockedOpen) {
      navigationStateRef.current = { ...initialGalleryNavigationState };
      setStage("visible");
      return;
    }

    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      // 模态框固定页面根节点时 window.scrollY 会暂时归零。这不是用户滚动，不能据此
      // 改变工具栏状态，否则关闭详情恢复原位置时会看到工具栏闪烁。
      if (isPageScrollLocked()) return;
      const position = currentPageScrollPosition();
      const delta = pageScrollDelta(previousPosition, position);
      previousPosition = position;
      const header = document.querySelector<HTMLElement>(
        ".gallery-page > .topbar"
      );
      // Select / Facet 菜单通过 Portal 渲染在 body；任一导航中的菜单展开时
      // 保持两级导航完整可见，避免触发器与浮层分离。
      const menuOpen = Boolean(
        toolbar.querySelector('[aria-expanded="true"]')
        || header?.querySelector('[aria-expanded="true"]')
      );
      const currentState = navigationStateRef.current;
      const nextState = advanceGalleryNavigation(currentState, {
        delta,
        scrollTop: position.top,
        toolbarHeight: toolbarHeightRef.current,
        lockedOpen: menuOpen
      });
      navigationStateRef.current = nextState;
      if (nextState.stage === currentState.stage) return;

      // inert 会把隐藏导航移出交互与无障碍树；先释放内部焦点，避免浏览器
      // 保留一个已不可见的焦点目标。
      if (
        currentState.stage === "visible"
        && nextState.stage !== "visible"
      ) {
        blurFocusedElement(toolbar);
      }
      if (
        nextState.stage === "hidden"
        && currentState.stage !== "hidden"
        && header
      ) {
        blurFocusedElement(header);
      }
      setStage(nextState.stage);
    };
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [lockedOpen, toolbarRef]);

  return {
    headerVisible: stage !== "hidden",
    height,
    toolbarVisible: stage === "visible"
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

export function useGalleryViewportControls() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [headerMenuExpanded, setHeaderMenuExpanded] = useState(false);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
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
  const navigationLockedOpen = mobileFiltersOpen || headerMenuExpanded;
  const {
    headerVisible,
    height: toolbarHeight,
    toolbarVisible
  } = useGalleryNavigationVisibility(
    toolbarRef,
    navigationLockedOpen
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
