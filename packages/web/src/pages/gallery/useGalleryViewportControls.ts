import {
  useCallback,
  useEffect,
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

const toolbarScrollDirectionThreshold = 8;
const backToTopViewportThreshold = 1;
function blurFocusedToolbarElement(toolbar: HTMLElement) {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && toolbar.contains(activeElement)) {
    activeElement.blur();
  }
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
      // 模态框固定页面根节点时 window.scrollY 会暂时归零。这不是用户滚动，不能据此
      // 改变工具栏状态，否则关闭详情恢复原位置时会看到工具栏闪烁。
      if (isPageScrollLocked()) return;
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
  const toolbarVisible = useGalleryToolbarVisibility(
    toolbarRef,
    mobileFiltersOpen
  );
  const backToTopVisible = useBackToTopVisibility();

  return {
    backToTopVisible,
    filterPanelHidden: disclosure.panelHidden,
    filterPanelRef: disclosure.panelRef,
    filterMenuDismissSignal: disclosure.menuDismissSignal,
    filterToggleRef: disclosure.triggerRef,
    filtersOpen,
    toggleFilters,
    toolbarRef,
    toolbarVisible,
  };
}
