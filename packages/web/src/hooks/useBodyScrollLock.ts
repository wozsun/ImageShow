import { useLayoutEffect } from "react";

let lockCount = 0;
let lockedScrollY = 0;
let previousBodyStyles: Pick<CSSStyleDeclaration, "position" | "top" | "left" | "right" | "width"> | null = null;
const pageScrollLockOffsetProperty = "--page-scroll-lock-offset";

export function isBodyScrollLocked() {
  return lockCount > 0;
}

// body 固定期间 window.scrollY 会暂时变成 0；需要比较页面滚动位置的组件
// 应读取锁定前保存的逻辑位置，避免把模态框开关误判成用户滚动。
export function getPageScrollY() {
  return lockCount ? lockedScrollY : window.scrollY;
}

export function useBodyScrollLock(active = true) {
  useLayoutEffect(() => {
    if (!active) return;
    if (!lockCount) {
      lockedScrollY = window.scrollY;
      const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      previousBodyStyles = {
        position: document.body.style.position,
        top: document.body.style.top,
        left: document.body.style.left,
        right: document.body.style.right,
        width: document.body.style.width
      };
      document.documentElement.style.setProperty(pageScrollLockOffsetProperty, `${lockedScrollY}px`);
      document.body.style.position = "fixed";
      document.body.style.top = `-${lockedScrollY}px`;
      document.body.style.left = "0";
      document.body.style.right = `${scrollbarWidth}px`;
      document.body.style.width = "auto";
    }
    lockCount += 1;
    document.documentElement.classList.add("modal-open");
    document.body.classList.add("modal-open");
    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount) return;
      document.documentElement.classList.remove("modal-open");
      document.body.classList.remove("modal-open");
      if (previousBodyStyles) {
        Object.assign(document.body.style, previousBodyStyles);
        previousBodyStyles = null;
      }
      document.documentElement.style.removeProperty(pageScrollLockOffsetProperty);
      window.scrollTo(0, lockedScrollY);
    };
  }, [active]);
}
