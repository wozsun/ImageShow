import { useLayoutEffect } from "react";

let lockCount = 0;
let lockedScrollY = 0;
let previousBodyStyles: Pick<CSSStyleDeclaration, "position" | "top" | "left" | "right" | "width"> | null = null;

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
      window.scrollTo(0, lockedScrollY);
    };
  }, [active]);
}
