import { useLayoutEffect, useRef, type RefObject } from "react";

export function useLoginVisualViewport(): RefObject<HTMLElement | null> {
  const loginRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const login = loginRef.current;
    const visualViewport = window.visualViewport;
    if (!login || !visualViewport) return;

    let frame: number | undefined;
    const update = () => {
      login.style.setProperty(
        "--login-card-center-y",
        `${visualViewport.offsetTop + visualViewport.height / 2}px`
      );
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };

    // 100dvh 跟随浏览器工具栏；iOS 软键盘只保证更新 visual viewport。
    // 卡片单独对齐真实可见中线，背景和文档仍保持完全锁定。
    update();
    window.addEventListener("resize", scheduleUpdate);
    visualViewport.addEventListener("resize", scheduleUpdate);
    visualViewport.addEventListener("scroll", scheduleUpdate);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      visualViewport.removeEventListener("resize", scheduleUpdate);
      visualViewport.removeEventListener("scroll", scheduleUpdate);
      login.style.removeProperty("--login-card-center-y");
    };
  }, []);

  return loginRef;
}
