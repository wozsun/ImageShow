import { useLayoutEffect } from "react";
import {
  createDialogTouchBoundary
} from "../lib/ui/dialog-touch-boundary.js";

let lockCount = 0;
let lockedScrollY = 0;
let lockedPageRoot: HTMLElement | null = null;
let lockedPageFocusTarget: HTMLElement | null = null;
let previousPageRootState: {
  ariaHidden: string | null;
  inert: boolean;
  styles: Pick<
    CSSStyleDeclaration,
    "position" | "top" | "left" | "right" | "width"
  >;
} | null = null;
let restoringPageScroll = false;
let restorationFrame: number | undefined;
let removeDialogTouchBoundary: (() => void) | null = null;

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

/**
 * The first lock makes the application root inert before dialog focus effects
 * run. Preserve its active opener so the focus trap can still record the
 * correct return target; nested dialogs continue to use their live parent
 * dialog focus instead.
 */
export function getPageScrollLockFocusTarget() {
  return lockCount === 1 && lockedPageFocusTarget?.isConnected
    ? lockedPageFocusTarget
    : null;
}

function installDialogTouchBoundary() {
  if (removeDialogTouchBoundary) return;
  const boundary = createDialogTouchBoundary(document);
  const captureNonPassive = {
    capture: true,
    passive: false
  } as const;
  document.addEventListener(
    "touchstart",
    boundary.onTouchStart,
    captureNonPassive
  );
  document.addEventListener(
    "touchmove",
    boundary.onTouchMove,
    captureNonPassive
  );
  document.addEventListener("touchend", boundary.onTouchEnd, true);
  document.addEventListener("touchcancel", boundary.onTouchEnd, true);
  removeDialogTouchBoundary = () => {
    document.removeEventListener("touchstart", boundary.onTouchStart, true);
    document.removeEventListener("touchmove", boundary.onTouchMove, true);
    document.removeEventListener("touchend", boundary.onTouchEnd, true);
    document.removeEventListener("touchcancel", boundary.onTouchEnd, true);
    boundary.reset();
    removeDialogTouchBoundary = null;
  };
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
        const activeElement = document.activeElement;
        lockedPageFocusTarget = activeElement instanceof HTMLElement
          && lockedPageRoot.contains(activeElement)
          ? activeElement
          : null;
        previousPageRootState = {
          ariaHidden: lockedPageRoot.getAttribute("aria-hidden"),
          inert: lockedPageRoot.inert,
          styles: {
            position: lockedPageRoot.style.position,
            top: lockedPageRoot.style.top,
            left: lockedPageRoot.style.left,
            right: lockedPageRoot.style.right,
            width: lockedPageRoot.style.width
          }
        };
        lockedPageRoot.style.position = "fixed";
        lockedPageRoot.style.top = `-${lockedScrollY}px`;
        lockedPageRoot.style.left = "0";
        lockedPageRoot.style.right = `${scrollbarWidth}px`;
        lockedPageRoot.style.width = "auto";
        lockedPageFocusTarget?.blur();
        lockedPageRoot.inert = true;
        lockedPageRoot.setAttribute("aria-hidden", "true");
      }
      installDialogTouchBoundary();
    }
    lockCount += 1;
    document.documentElement.classList.add("modal-open");
    document.body.classList.add("modal-open");
    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount) return;
      document.documentElement.classList.remove("modal-open");
      document.body.classList.remove("modal-open");
      removeDialogTouchBoundary?.();
      if (lockedPageRoot && previousPageRootState) {
        Object.assign(lockedPageRoot.style, previousPageRootState.styles);
        lockedPageRoot.inert = previousPageRootState.inert;
        if (previousPageRootState.ariaHidden === null) {
          lockedPageRoot.removeAttribute("aria-hidden");
        } else {
          lockedPageRoot.setAttribute(
            "aria-hidden",
            previousPageRootState.ariaHidden
          );
        }
      }
      lockedPageRoot = null;
      lockedPageFocusTarget = null;
      previousPageRootState = null;
      restorePageScroll();
    };
  }, [active]);
}
