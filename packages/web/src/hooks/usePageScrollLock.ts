import { useLayoutEffect } from "react";

let lockCount = 0;
let lockedScrollY = 0;
let lockedPageRoot: HTMLElement | null = null;
let previousPageRootStyles: Pick<
  CSSStyleDeclaration,
  "position" | "top" | "left" | "right" | "width"
> | null = null;
let restoringPageScroll = false;
let restorationFrame: number | undefined;

export const pageScrollRestoredEvent = "imageshow:page-scroll-restored";

function cancelPageScrollRestoration() {
  if (restorationFrame !== undefined) {
    window.cancelAnimationFrame(restorationFrame);
    restorationFrame = undefined;
  }
  restoringPageScroll = false;
  document.documentElement.classList.remove("page-scroll-restoring");
}

function restorePageScroll() {
  // Safari 可能要等固定根节点重回布局后才应用 scrollTo。交接期间继续冻结逻辑
  // 滚动读数，再于后一帧移除可观察的状态类并发布已经恢复的页面位置。
  restoringPageScroll = true;
  document.documentElement.classList.add("page-scroll-restoring");
  window.scrollTo(0, lockedScrollY);
  restorationFrame = window.requestAnimationFrame(() => {
    window.scrollTo(0, lockedScrollY);
    restorationFrame = window.requestAnimationFrame(() => {
      restorationFrame = undefined;
      restoringPageScroll = false;
      document.documentElement.classList.remove("page-scroll-restoring");
      window.dispatchEvent(new Event(pageScrollRestoredEvent));
    });
  });
}

export function isPageScrollLocked() {
  return lockCount > 0 || restoringPageScroll;
}

// 页面根节点固定期间 window.scrollY 会暂时变成 0；需要比较页面滚动位置的组件
// 应读取锁定前保存的逻辑位置，避免把模态框开关误判成用户滚动。
export function getPageScrollY() {
  return isPageScrollLocked() ? lockedScrollY : window.scrollY;
}

export function usePageScrollLock(active = true) {
  useLayoutEffect(() => {
    if (!active) return;
    if (!lockCount) {
      if (restoringPageScroll) {
        cancelPageScrollRestoration();
      } else {
        lockedScrollY = window.scrollY;
      }
      const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      lockedPageRoot = document.getElementById("root");
      if (lockedPageRoot) {
        previousPageRootStyles = {
          position: lockedPageRoot.style.position,
          top: lockedPageRoot.style.top,
          left: lockedPageRoot.style.left,
          right: lockedPageRoot.style.right,
          width: lockedPageRoot.style.width
        };
        lockedPageRoot.style.position = "fixed";
        lockedPageRoot.style.top = `-${lockedScrollY}px`;
        lockedPageRoot.style.left = "0";
        lockedPageRoot.style.right = `${scrollbarWidth}px`;
        lockedPageRoot.style.width = "auto";
      }
    }
    lockCount += 1;
    document.documentElement.classList.add("modal-open");
    document.body.classList.add("modal-open");
    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount) return;
      document.documentElement.classList.remove("modal-open");
      document.body.classList.remove("modal-open");
      if (lockedPageRoot && previousPageRootStyles) {
        Object.assign(lockedPageRoot.style, previousPageRootStyles);
      }
      lockedPageRoot = null;
      previousPageRootStyles = null;
      restorePageScroll();
    };
  }, [active]);
}
