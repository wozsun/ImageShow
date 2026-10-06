import { useCallback, type RefCallback } from "react";
import { mobileViewportMediaQuery } from "./useMediaQuery.js";
import { isPageScrollLocked } from "./usePageScrollLock.js";

/**
 * 窄屏后台页面的操作区显隐。带 .workspace-has-toolbar 的工作区在窄屏整体原生滚动：标题区
 * （data-workspace-pinned）吸顶；唯一的 `.workspace-toolbar` 以 sticky top 吸在标题区下沿，
 * 位于一条从标题区下沿开始、绝对定位的轨道内。sticky 元素不能离开轨道，所以轨道下沿决定它
 * 随滚动的行为，移动本身全部由浏览器原生滚动完成：
 * - 下滑时把轨道下沿设在操作区当前底边，随后轨道下沿随内容上移，把操作区推到标题区下方；
 * - 完全隐藏后开始上滑时，把轨道下沿设在标题区下沿（计入这一次上滑的距离），随后随内容下移，
 *   操作区跟着露出，完全露出后被 sticky top 停住，继续上滑也保持不动。
 * 脚本只在滑动方向改变时写一次轨道高度，不逐帧参与。
 *
 * 焦点规则：滚动时若操作区内有键盘焦点、展开的菜单或面板，或页面被弹窗锁定，保持完整显示；
 * 完全隐藏时让出操作区内的指针焦点；焦点进入未完全显示的操作区（Tab 或弹窗归还焦点）时立即
 * 显示。
 *
 * 返回挂在工作区根元素上的回调 ref；元素出现时绑定、移除时清理，不受页面提前返回影响。
 */
export function useWorkspaceToolbarCollapse(): RefCallback<HTMLElement> {
  return useCallback((workspace: HTMLElement | null) => {
    if (!workspace) return;
    const mobileViewport = window.matchMedia(mobileViewportMediaQuery);
    let active = false;
    // 轨道下沿在滚动内容中的位置；轨道上沿固定在标题区下沿（pinnedHeight）。
    let railBottom = 0;
    let pinnedHeight = 0;
    let toolbarHeight = 0;
    let toolbar: HTMLElement | null = null;
    let rail: HTMLElement | null = null;
    let pinned: HTMLElement | null = null;
    let previousTop = workspace.scrollTop;

    const resizeObserver = new ResizeObserver(() => measure());

    const scrollTop = () => Math.min(
      Math.max(workspace.scrollTop, 0),
      Math.max(0, workspace.scrollHeight - workspace.clientHeight)
    );
    const setRailBottom = (next: number) => {
      railBottom = Math.max(Math.round(next), pinnedHeight + toolbarHeight);
      rail?.style.setProperty("height", `${railBottom - pinnedHeight}px`);
    };
    // 操作区底边在视口中的位置：不超过标题区下沿时完全隐藏，达到标题区下沿加自身高度时完整显示。
    const visibleBottom = (top: number) => railBottom - top;
    const showFully = () => setRailBottom(scrollTop() + pinnedHeight + toolbarHeight);
    const releaseHiddenFocus = (top: number) => {
      const activeElement = document.activeElement;
      if (
        toolbar &&
        visibleBottom(top) <= pinnedHeight &&
        activeElement instanceof HTMLElement &&
        toolbar.contains(activeElement)
      ) {
        activeElement.blur();
      }
    };

    const observe = (element: HTMLElement | null, current: HTMLElement | null) => {
      if (element === current) return current;
      if (current) resizeObserver.unobserve(current);
      if (element) resizeObserver.observe(element);
      return element;
    };
    const clear = () => {
      rail?.style.removeProperty("height");
      for (const name of ["--workspace-pinned-height", "--workspace-toolbar-height"]) {
        workspace.style.removeProperty(name);
      }
    };
    const measure = () => {
      const nextToolbar = workspace.querySelector<HTMLElement>(".workspace-toolbar");
      if (rail && nextToolbar?.parentElement !== rail) rail.style.removeProperty("height");
      toolbar = observe(nextToolbar, toolbar);
      rail = toolbar?.parentElement ?? null;
      pinned = observe(workspace.querySelector<HTMLElement>("[data-workspace-pinned]"), pinned);
      active = mobileViewport.matches && toolbar !== null && rail !== null && pinned !== null;
      if (!active || !toolbar || !pinned) {
        clear();
        return;
      }
      // 方向判断从当前位置重新开始，不把断点切换或尺寸变化前的位置当作上一次滚动。
      previousTop = scrollTop();
      const wasShown = visibleBottom(previousTop) >= pinnedHeight + toolbarHeight;
      const wasHidden = visibleBottom(previousTop) <= pinnedHeight;
      pinnedHeight = pinned.offsetHeight;
      toolbarHeight = toolbar.offsetHeight;
      workspace.style.setProperty("--workspace-pinned-height", `${pinnedHeight}px`);
      workspace.style.setProperty("--workspace-toolbar-height", `${toolbarHeight}px`);
      if (wasShown) showFully();
      // 完全隐藏时操作区自身增高：轨道下沿留在标题区下沿，不让下限夹紧把高度差露出来。
      else if (wasHidden) setRailBottom(previousTop + pinnedHeight);
      else setRailBottom(railBottom);
    };

    const toolbarInUse = () =>
      isPageScrollLocked() ||
      (toolbar !== null &&
        toolbar.querySelector(':focus-visible, [aria-expanded="true"]') !== null);

    const handleScroll = () => {
      if (!active) return;
      const top = scrollTop();
      const delta = top - previousTop;
      previousTop = top;
      const shownBottom = pinnedHeight + toolbarHeight;
      if (toolbarInUse()) {
        if (visibleBottom(top) < shownBottom) showFully();
        return;
      }
      if (delta > 0 && visibleBottom(top) > shownBottom) {
        // 正被 sticky 停住：轨道下沿贴住操作区底边并计入这一次下滑的距离，随后随内容把它推走。
        setRailBottom(top + shownBottom - delta);
      } else if (delta < 0 && visibleBottom(top) <= pinnedHeight) {
        // 已完全隐藏：轨道下沿放到标题区下沿并计入这一次上滑的距离，随后操作区随内容露出。
        setRailBottom(top + pinnedHeight - delta);
      }
      releaseHiddenFocus(top);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (
        active &&
        toolbar &&
        event.target instanceof Node &&
        toolbar.contains(event.target) &&
        visibleBottom(scrollTop()) < pinnedHeight + toolbarHeight
      ) {
        showFully();
      }
    };

    resizeObserver.observe(workspace);
    workspace.addEventListener("scroll", handleScroll, { passive: true });
    workspace.addEventListener("focusin", handleFocusIn);
    mobileViewport.addEventListener("change", measure);
    measure();
    return () => {
      resizeObserver.disconnect();
      workspace.removeEventListener("scroll", handleScroll);
      workspace.removeEventListener("focusin", handleFocusIn);
      mobileViewport.removeEventListener("change", measure);
      clear();
    };
  }, []);
}
